import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CODEFOG_COMMAND } from "./cli-command.js";
import {
  discoverDocFiles,
  isInstructionFile,
  parseMarkdownDoc,
  type DocBlock,
  type ParsedDocFile,
} from "./doc-markdown.js";
import {
  buildRepoSymbolIndex,
  checkExternalUrlReachable,
  detectInstructionConflictFindings,
  isGeneratedArtifactPath,
  loadPackageManifestInfo,
  looksLikePathToken,
  parseCandidateSymbolToken,
  pathExists,
  resolveInlineCommandClaim,
  resolveSymbolInIndex,
  type PackageManifestInfo,
  type RepoSymbol,
  type RepoSymbolIndex,
} from "./doc-resolution.js";
import { evaluateDocCodeBlockClaim } from "./doc-runners.js";
import {
  createDocTimelineOracle,
  getLookupCommitSha,
  isReferentNewerThanBlock,
  type DocTimelinePoint,
} from "./doc-timeline.js";
import { createGitTimelineSession } from "./git-freshness.js";
import { loadGitignoreMatchers } from "./polyglot.js";
import {
  computeRiskScore,
  computeTrustScore,
  createDeterministicFindingId,
  emptyLocByState,
} from "./scoring.js";
import type {
  DocClaim,
  DocReferent,
  EvidenceState,
  Finding,
  LocByState,
} from "./types.js";

export {
  discoverDocFiles,
  isInstructionFile,
  parseMarkdownDoc,
  slugifyMarkdownHeading,
  type DocBlock,
  type ParsedDocFile,
} from "./doc-markdown.js";

export {
  buildRepoSymbolIndex,
  extractSymbolsFromSource,
  inferCommandIntent,
  isGeneratedArtifactPath,
  loadPackageManifestInfo,
  type PackageManifestInfo,
  type RepoSymbol,
  type RepoSymbolIndex,
} from "./doc-resolution.js";

export { type DocTimelinePoint } from "./doc-timeline.js";

export interface DocAnalysisResult {
  docTrustScore: number;
  totalDocClaims: number;
  docClaimsByState: LocByState;
  docClaims: DocClaim[];
  docFindings: Finding[];
  parsedDocs: ParsedDocFile[];
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

export async function analyzeDocClaims(options: {
  rootDir: string;
  checkExternalLinks?: boolean;
  runDocs?: boolean;
  docFileOverrides?: Map<string, string>;
  extraDocFiles?: string[];
}): Promise<DocAnalysisResult> {
  const rootDir = path.resolve(options.rootDir);
  const [discoveredDocFiles, symbolIndex, gitignoreMatchers, pkgInfo, gitSession] =
    await Promise.all([
      discoverDocFiles(rootDir),
      buildRepoSymbolIndex(rootDir),
      loadGitignoreMatchers(rootDir),
      loadPackageManifestInfo(rootDir),
      createGitTimelineSession(rootDir),
    ]);
  const docFileSet = new Set<string>(discoveredDocFiles);
  for (const extra of options.extraDocFiles ?? []) {
    docFileSet.add(toPosix(extra));
  }
  const docFiles = Array.from(docFileSet).sort((a, b) => a.localeCompare(b));
  const parsedDocs: ParsedDocFile[] = [];
  const parsedDocsByPath = new Map<string, ParsedDocFile>();

  for (const relPath of docFiles) {
    try {
      const overrideContent = options.docFileOverrides?.get(relPath);
      const content =
        overrideContent !== undefined
          ? overrideContent
          : await fs.readFile(path.join(rootDir, relPath), "utf8");
      const parsed = parseMarkdownDoc(relPath, content);
      parsedDocs.push(parsed);
      parsedDocsByPath.set(relPath, parsed);
    } catch {
      // skip unreadable file
    }
  }

  const timeline = createDocTimelineOracle(gitSession, options.docFileOverrides);
  const docClaims: DocClaim[] = [];
  let sharedCargoTargetDir: string | undefined;

  try {
    for (const doc of parsedDocs) {
      if (doc.ignoredFile) continue;

      for (const block of doc.blocks) {
        if (block.ignored) continue;
        if (block.kind === "code-block") {
          if (
            options.runDocs &&
            (block.language ?? "").trim().toLowerCase() === "rust" &&
            !sharedCargoTargetDir
          ) {
            sharedCargoTargetDir = await fs.mkdtemp(
              path.join(os.tmpdir(), "codefog-rundocs-rust-target-"),
            );
          }
          const codeClaim = await evaluateDocCodeBlockClaim({
            rootDir,
            docFile: doc.file,
            block,
            runDocs: Boolean(options.runDocs),
            symbolIndex,
            pkgInfo,
            ...(sharedCargoTargetDir ? { cargoTargetDir: sharedCargoTargetDir } : {}),
          });
          if (codeClaim) {
            docClaims.push(codeClaim);
          }
          continue;
        }

        const blockPoint: DocTimelinePoint | null = await timeline.findBlockLastSubstantivePoint(
          doc.file,
          block,
        );
        const lookupSha = getLookupCommitSha(blockPoint, gitSession);
        const blockLines = doc.lines.slice(block.startLine - 1, block.endLine);

        for (let lineIdx = 0; lineIdx < blockLines.length; lineIdx++) {
          const rawLine = blockLines[lineIdx]!;
          const lineNum = block.startLine + lineIdx;
          const lineWithoutComments = rawLine.replace(/<!--[\s\S]*?-->/g, "");

          // 1. Extract Markdown links [label](href) (excluding images ![alt](src))
          const linkReferentsOnLine = new Set<string>();
          const linkRe = /(?<!\!)\[([^\]]*)\]\(([^)]+)\)/g;
          let lm: RegExpExecArray | null;
          while ((lm = linkRe.exec(lineWithoutComments)) !== null) {
            const rawHref = lm[2]!.trim().replace(/^<|>$/g, "").split(/\s+/)[0] ?? "";
            if (!rawHref || /^(?:mailto:|tel:|javascript:|data:)/i.test(rawHref)) {
              continue;
            }
            linkReferentsOnLine.add(rawHref);

            if (/^https?:\/\//i.test(rawHref)) {
              let extState: EvidenceState = "fog";
              if (options.checkExternalLinks) {
                const ok = await checkExternalUrlReachable(rawHref);
                extState = ok ? "verified" : "weak-evidence";
              }
              docClaims.push({
                id: createDeterministicFindingId(doc.file, `${lineNum}:${rawHref}`),
                file: doc.file,
                kind: "link",
                text: rawHref,
                rawText: rawHref,
                referentText: rawHref,
                startLine: lineNum,
                endLine: lineNum,
                blockKind: block.kind,
                blockStartLine: block.startLine,
                blockEndLine: block.endLine,
                state: extState,
                referents: [{ kind: "external-url", url: rawHref }],
                referent: { kind: "external-url", url: rawHref },
              });
              continue;
            }

            if (rawHref.startsWith("#")) {
              const anchorSlug = rawHref.slice(1).toLowerCase();
              const heading = doc.headings.find((h) => h.slug === anchorSlug);
              const resolved = Boolean(heading);
              const filePoint = resolved ? await timeline.findFileLatestPoint(doc.file) : null;
              const referent: DocReferent | undefined = heading
                ? {
                    kind: "anchor",
                    file: doc.file,
                    anchor: anchorSlug,
                    startLine: heading.line,
                    endLine: heading.line,
                    ...(filePoint
                      ? {
                          lastModifiedCommit: filePoint.shortSha,
                          lastModifiedAt: filePoint.isoDate,
                        }
                      : {}),
                  }
                : undefined;
              let existedAtClaimCommit: boolean | undefined;
              if (!resolved && gitSession.isGitRepo && lookupSha) {
                const histDoc = await timeline.getParsedDocAtCommit(lookupSha, doc.file);
                existedAtClaimCommit = Boolean(
                  histDoc?.headings.some((h) => h.slug === anchorSlug),
                );
              }
              docClaims.push({
                id: createDeterministicFindingId(doc.file, `${lineNum}:${rawHref}`),
                file: doc.file,
                kind: "anchor",
                text: rawHref,
                rawText: rawHref,
                referentText: rawHref,
                startLine: lineNum,
                endLine: lineNum,
                blockKind: block.kind,
                blockStartLine: block.startLine,
                blockEndLine: block.endLine,
                state: resolved ? "verified" : "fog-returned",
                referents: referent ? [referent] : [],
                ...(referent ? { referent } : {}),
                ...(existedAtClaimCommit !== undefined ? { existedAtClaimCommit } : {}),
              });
              continue;
            }

            // Local file link (with optional #anchor)
            const [filePartRaw, anchorPart] = rawHref.split("#");
            const filePart = filePartRaw ?? "";
            const docDir = path.posix.dirname(doc.file);
            const resolvedRel = filePart.startsWith("/")
              ? path.posix.normalize(filePart.slice(1))
              : path.posix.normalize(path.posix.join(docDir, filePart));

            if (isGeneratedArtifactPath(resolvedRel, gitignoreMatchers)) {
              const genRef: DocReferent = { kind: "generated-artifact", file: resolvedRel };
              docClaims.push({
                id: createDeterministicFindingId(doc.file, `${lineNum}:${rawHref}`),
                file: doc.file,
                kind: "link",
                text: rawHref,
                rawText: rawHref,
                referentText: rawHref,
                startLine: lineNum,
                endLine: lineNum,
                blockKind: block.kind,
                blockStartLine: block.startLine,
                blockEndLine: block.endLine,
                state: "fog",
                referents: [genRef],
                referent: genRef,
              });
              continue;
            }

            const exists = await pathExists(path.join(rootDir, resolvedRel));
            let anchorValid = true;
            if (exists && anchorPart) {
              let referentDoc = parsedDocsByPath.get(resolvedRel);
              if (!referentDoc && resolvedRel.toLowerCase().endsWith(".md")) {
                try {
                  const referentContent = await fs.readFile(path.join(rootDir, resolvedRel), "utf8");
                  referentDoc = parseMarkdownDoc(resolvedRel, referentContent);
                  parsedDocsByPath.set(resolvedRel, referentDoc);
                } catch {
                  anchorValid = false;
                }
              }
              if (referentDoc) {
                anchorValid = referentDoc.headings.some(
                  (h) => h.slug === anchorPart.toLowerCase(),
                );
              }
            }

            const state: EvidenceState = exists && anchorValid ? "verified" : "fog-returned";
            const filePoint = await timeline.findFileLatestPoint(resolvedRel);
            let existedAtClaimCommit: boolean | undefined;
            if (state === "fog-returned" && gitSession.isGitRepo && lookupSha) {
              const trackedAtCommit = await gitSession.listTrackedFilesAtCommit(lookupSha);
              if (!trackedAtCommit.has(resolvedRel)) {
                existedAtClaimCommit = false;
              } else if (anchorPart && resolvedRel.toLowerCase().endsWith(".md")) {
                const histDoc = await timeline.getParsedDocAtCommit(lookupSha, resolvedRel);
                existedAtClaimCommit = Boolean(
                  histDoc?.headings.some((h) => h.slug === anchorPart.toLowerCase()),
                );
              } else {
                existedAtClaimCommit = true;
              }
            }
            const referent: DocReferent | undefined =
              exists && anchorValid
                ? {
                    kind: "file",
                    file: resolvedRel,
                    ...(anchorPart ? { anchor: anchorPart.toLowerCase() } : {}),
                    ...(filePoint
                      ? {
                          lastModifiedCommit: filePoint.shortSha,
                          lastModifiedAt: filePoint.isoDate,
                        }
                      : {}),
                  }
                : existedAtClaimCommit
                  ? {
                      kind: "file",
                      file: resolvedRel,
                      ...(anchorPart ? { anchor: anchorPart.toLowerCase() } : {}),
                      ...(filePoint
                        ? {
                            lastModifiedCommit: filePoint.shortSha,
                            lastModifiedAt: filePoint.isoDate,
                          }
                        : {}),
                    }
                  : undefined;
            docClaims.push({
              id: createDeterministicFindingId(doc.file, `${lineNum}:${rawHref}`),
              file: doc.file,
              kind: "link",
              text: rawHref,
              rawText: rawHref,
              referentText: rawHref,
              startLine: lineNum,
              endLine: lineNum,
              blockKind: block.kind,
              blockStartLine: block.startLine,
              blockEndLine: block.endLine,
              state,
              referents: referent ? [referent] : [],
              ...(referent ? { referent } : {}),
              ...(existedAtClaimCommit !== undefined ? { existedAtClaimCommit } : {}),
            });
          }

          // 2. Extract inline code spans `...`
          const inlineRe = /`([^`\n]+)`/g;
          let im: RegExpExecArray | null;
          while ((im = inlineRe.exec(lineWithoutComments)) !== null) {
            const code = im[1]!.trim();
            if (!code || linkReferentsOnLine.has(code)) continue;

            // Command claim
            const cmdClaim = await resolveInlineCommandClaim(
              code,
              rootDir,
              pkgInfo,
              isInstructionFile(doc.file),
            );
            if (cmdClaim) {
              let cmdState = cmdClaim.state;
              let cmdReferent = cmdClaim.referent;
              let existedAtClaimCommit: boolean | undefined;

              if (
                cmdReferent?.kind === "script" &&
                cmdReferent.script &&
                cmdReferent.scriptDefinition !== undefined
              ) {
                const scriptPoint = await timeline.findScriptLastChangePoint(
                  cmdReferent.script,
                  cmdReferent.scriptDefinition,
                );
                if (scriptPoint) {
                  cmdReferent = {
                    ...cmdReferent,
                    lastModifiedCommit: scriptPoint.shortSha,
                    lastModifiedAt: scriptPoint.isoDate,
                  };
                }
                if (isReferentNewerThanBlock(scriptPoint, blockPoint)) {
                  cmdState = "fog-returned";
                }
              } else if (cmdReferent?.file) {
                const refPoint = await timeline.findFileLatestPoint(cmdReferent.file);
                if (refPoint) {
                  cmdReferent = {
                    ...cmdReferent,
                    lastModifiedCommit: refPoint.shortSha,
                    lastModifiedAt: refPoint.isoDate,
                  };
                }
              } else if (cmdState === "fog-returned" && gitSession.isGitRepo && lookupSha) {
                const firstSeg =
                  cmdClaim.referentText.split(/\s*(?:&&|\|\||;)\s*/)[0] ?? cmdClaim.referentText;
                const pmRunM =
                  /^(?:npm|pnpm|yarn|bun)\s+run(?:-script)?\s+([A-Za-z0-9_:.-]+)/.exec(firstSeg);
                const pmAliasM =
                  /^(?:npm|pnpm|yarn|bun)\s+(test|t|tst|start|stop|restart)\b/.exec(firstSeg);
                const nodeFileM =
                  /^(?:npx\s+)?(?:node|tsx|ts-node)\s+(?:-[A-Za-z0-9-=]+\s+)*([^\s-][^\s]*)/.exec(
                    firstSeg,
                  );
                if (pmRunM?.[1] || pmAliasM?.[1]) {
                  const sName =
                    pmRunM?.[1] ??
                    (pmAliasM![1] === "t" || pmAliasM![1] === "tst" ? "test" : pmAliasM![1]!);
                  const histScripts = await timeline.getPackageScriptsAtCommit(lookupSha);
                  existedAtClaimCommit = histScripts.has(sName);
                } else if (nodeFileM?.[1]) {
                  const fArg = nodeFileM[1].replace(/^\.\//, "");
                  const tracked = await gitSession.listTrackedFilesAtCommit(lookupSha);
                  existedAtClaimCommit = tracked.has(fArg);
                } else {
                  const histManifest = await timeline.getPackageManifestAtCommit(lookupSha);
                  const tokens = firstSeg.split(/\s+/);
                  let idx = 0;
                  if (tokens[0] === "npx") {
                    idx = 1;
                    if (tokens[idx] === "--yes" || tokens[idx] === "-y") idx++;
                  }
                  const binToken = (tokens[idx] ?? "").replace(/@[^\s/]+$/, "");
                  const nextToken = tokens[idx + 1];
                  existedAtClaimCommit = Boolean(
                    binToken &&
                      nextToken &&
                      histManifest.binNames.has(binToken) &&
                      histManifest.binSubcommands.has(nextToken),
                  );
                }
              }

              docClaims.push({
                id: createDeterministicFindingId(doc.file, `${lineNum}:${code}`),
                file: doc.file,
                kind: "command",
                text: code,
                rawText: code,
                referentText: cmdClaim.referentText,
                startLine: lineNum,
                endLine: lineNum,
                blockKind: block.kind,
                blockStartLine: block.startLine,
                blockEndLine: block.endLine,
                state: cmdState,
                referents: cmdReferent ? [cmdReferent] : [],
                ...(cmdReferent ? { referent: cmdReferent } : {}),
                ...(cmdClaim.commandIntent ? { commandIntent: cmdClaim.commandIntent } : {}),
                ...(existedAtClaimCommit !== undefined ? { existedAtClaimCommit } : {}),
              });
              continue;
            }

            // Inline anchor `#slug`
            if (
              /^#[A-Za-z][A-Za-z0-9_-]*$/.test(code) &&
              !/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(code)
            ) {
              const anchorSlug = code.slice(1).toLowerCase();
              const heading = doc.headings.find((h) => h.slug === anchorSlug);
              const filePoint = heading ? await timeline.findFileLatestPoint(doc.file) : null;
              const referent: DocReferent | undefined = heading
                ? {
                    kind: "anchor",
                    file: doc.file,
                    anchor: anchorSlug,
                    startLine: heading.line,
                    endLine: heading.line,
                    ...(filePoint
                      ? {
                          lastModifiedCommit: filePoint.shortSha,
                          lastModifiedAt: filePoint.isoDate,
                        }
                      : {}),
                  }
                : undefined;
              let existedAtClaimCommit: boolean | undefined;
              if (!heading && gitSession.isGitRepo && lookupSha) {
                const histDoc = await timeline.getParsedDocAtCommit(lookupSha, doc.file);
                existedAtClaimCommit = Boolean(
                  histDoc?.headings.some((h) => h.slug === anchorSlug),
                );
              }
              docClaims.push({
                id: createDeterministicFindingId(doc.file, `${lineNum}:${code}`),
                file: doc.file,
                kind: "anchor",
                text: code,
                rawText: code,
                referentText: code,
                startLine: lineNum,
                endLine: lineNum,
                blockKind: block.kind,
                blockStartLine: block.startLine,
                blockEndLine: block.endLine,
                state: heading ? "verified" : "fog-returned",
                referents: referent ? [referent] : [],
                ...(referent ? { referent } : {}),
                ...(existedAtClaimCommit !== undefined ? { existedAtClaimCommit } : {}),
              });
              continue;
            }

            // Path claim
            if (looksLikePathToken(code)) {
              const cleanPath = (code.split("#")[0] ?? code)
                .replace(/:\d+(?:-\d+)?$/, "")
                .replace(/^\.\//, "");

              if (isGeneratedArtifactPath(cleanPath, gitignoreMatchers)) {
                const genRef: DocReferent = { kind: "generated-artifact", file: cleanPath };
                docClaims.push({
                  id: createDeterministicFindingId(doc.file, `${lineNum}:${code}`),
                  file: doc.file,
                  kind: "path",
                  text: code,
                  rawText: code,
                  referentText: code,
                  startLine: lineNum,
                  endLine: lineNum,
                  blockKind: block.kind,
                  blockStartLine: block.startLine,
                  blockEndLine: block.endLine,
                  state: "fog",
                  referents: [genRef],
                  referent: genRef,
                });
                continue;
              }

              const exists = await pathExists(path.join(rootDir, cleanPath));
              const filePoint = await timeline.findFileLatestPoint(cleanPath);
              let existedAtClaimCommit: boolean | undefined;
              if (!exists && gitSession.isGitRepo && lookupSha) {
                const trackedAtCommit = await gitSession.listTrackedFilesAtCommit(lookupSha);
                existedAtClaimCommit = trackedAtCommit.has(cleanPath);
              }
              const referent: DocReferent | undefined = exists
                ? {
                    kind: "file",
                    file: cleanPath,
                    ...(filePoint
                      ? {
                          lastModifiedCommit: filePoint.shortSha,
                          lastModifiedAt: filePoint.isoDate,
                        }
                      : {}),
                  }
                : existedAtClaimCommit
                  ? {
                      kind: "file",
                      file: cleanPath,
                      ...(filePoint
                        ? {
                            lastModifiedCommit: filePoint.shortSha,
                            lastModifiedAt: filePoint.isoDate,
                          }
                        : {}),
                    }
                  : undefined;
              docClaims.push({
                id: createDeterministicFindingId(doc.file, `${lineNum}:${code}`),
                file: doc.file,
                kind: "path",
                text: code,
                rawText: code,
                referentText: code,
                startLine: lineNum,
                endLine: lineNum,
                blockKind: block.kind,
                blockStartLine: block.startLine,
                blockEndLine: block.endLine,
                state: exists ? "verified" : "fog-returned",
                referents: referent ? [referent] : [],
                ...(referent ? { referent } : {}),
                ...(existedAtClaimCommit !== undefined ? { existedAtClaimCommit } : {}),
              });
              continue;
            }

            // Symbol claim
            const symCandidate = parseCandidateSymbolToken(code);
            if (symCandidate) {
              const matchedSymbols = resolveSymbolInIndex(symCandidate, symbolIndex);
              if (matchedSymbols.length > 0) {
                const referentName = symCandidate.qualifiedName ?? symCandidate.bareName ?? code;
                const referents: DocReferent[] = [];
                let staleReferent: DocReferent | undefined;

                for (const s of matchedSymbols) {
                  const symPoint = await timeline.findSymbolLastRuntimeChangePoint(s);
                  const ref: DocReferent = {
                    kind: "symbol",
                    file: s.file,
                    symbol: s.name,
                    startLine: s.startLine,
                    endLine: s.endLine,
                    runtimeFingerprint: s.runtimeFingerprint,
                    ...(symPoint
                      ? {
                          lastModifiedCommit: symPoint.shortSha,
                          lastModifiedAt: symPoint.isoDate,
                        }
                      : {}),
                  };
                  referents.push(ref);
                  if (isReferentNewerThanBlock(symPoint, blockPoint) && !staleReferent) {
                    staleReferent = ref;
                  }
                }

                const symState: EvidenceState = staleReferent ? "fog-returned" : "weak-evidence";
                docClaims.push({
                  id: createDeterministicFindingId(doc.file, `${lineNum}:${code}`),
                  file: doc.file,
                  kind: "symbol",
                  text: referentName,
                  rawText: code,
                  referentText: referentName,
                  startLine: lineNum,
                  endLine: lineNum,
                  blockKind: block.kind,
                  blockStartLine: block.startLine,
                  blockEndLine: block.endLine,
                  state: symState,
                  referents,
                  referent: staleReferent ?? referents[0],
                });
              } else if (gitSession.isGitRepo && blockPoint) {
                const candidateShas =
                  blockPoint.kind === "worktree"
                    ? gitSession.commits.map((c) => c.sha)
                    : [blockPoint.commit.sha];
                let histMatches: RepoSymbol[] = [];
                let existedAtClaimCommit = false;
                for (const sha of candidateShas) {
                  const histIndex = await timeline.getSymbolIndexAtCommit(sha);
                  const matchesAtCommit = resolveSymbolInIndex(symCandidate, histIndex);
                  if (matchesAtCommit.length > 0) {
                    histMatches = matchesAtCommit;
                    existedAtClaimCommit = sha === lookupSha;
                    break;
                  }
                }
                if (histMatches.length > 0) {
                  const referentName = symCandidate.qualifiedName ?? symCandidate.bareName ?? code;
                  const referents: DocReferent[] = [];
                  for (const hs of histMatches) {
                    const removalPoint = await timeline.findSymbolRemovalPoint(hs);
                    referents.push({
                      kind: "symbol",
                      file: hs.file,
                      symbol: hs.name,
                      startLine: hs.startLine,
                      endLine: hs.endLine,
                      runtimeFingerprint: hs.runtimeFingerprint,
                      ...(removalPoint
                        ? {
                            lastModifiedCommit: removalPoint.shortSha,
                            lastModifiedAt: removalPoint.isoDate,
                          }
                        : {}),
                    });
                  }
                  docClaims.push({
                    id: createDeterministicFindingId(doc.file, `${lineNum}:${code}`),
                    file: doc.file,
                    kind: "symbol",
                    text: referentName,
                    rawText: code,
                    referentText: referentName,
                    startLine: lineNum,
                    endLine: lineNum,
                    blockKind: block.kind,
                    blockStartLine: block.startLine,
                    blockEndLine: block.endLine,
                    state: "fog-returned",
                    referents,
                    referent: referents[0],
                    existedAtClaimCommit,
                  });
                }
              }
            }
          }
        }
      }
    }
  } finally {
    if (sharedCargoTargetDir) {
      await fs.rm(sharedCargoTargetDir, { recursive: true, force: true });
    }
  }

  const docClaimsByState = emptyLocByState();
  const docFindings: Finding[] = detectInstructionConflictFindings(docClaims);

  for (const claim of docClaims) {
    docClaimsByState[claim.state]++;
    if (claim.state === "fog-returned") {
      const existedNote =
        claim.existedAtClaimCommit === true
          ? " (声明最后修改时引用对象存在 / referent existed at claim commit)"
          : claim.existedAtClaimCommit === false
            ? " (声明最后修改时引用对象不存在 / referent did not exist at claim commit)"
            : "";
      docFindings.push({
        id: claim.id,
        title: claim.text,
        state: "fog-returned",
        subjectType: "doc",
        tags: ["doc-fog-returned"],
        riskScore: computeRiskScore({
          unverifiedLoc: 1,
          churn90d: 1,
          cyclomaticComplexity: 1,
          state: "fog-returned",
        }),
        agentReady: true,
        location: {
          file: claim.file,
          symbol: claim.text,
          startLine: claim.startLine,
          endLine: claim.endLine,
        },
        reason: claim.executionOutput
          ? `Doc claim '${claim.text}' (${claim.kind}) in ${claim.file}:${claim.startLine}-${claim.endLine} failed execution (Fog Returned): ${claim.executionOutput}${existedNote}`
          : `Doc claim '${claim.text}' (${claim.kind}) in ${claim.file}:${claim.startLine} is outdated or could not be resolved (Fog Returned)${existedNote}.`,
        evidence: {
          executedByTests: 0,
          assertionsOnOutcome: 0,
          pseudoTested: false,
          oracleContest: false,
          oracleIds: [],
          missedBoundary: false,
          survivingMutants: [],
        },
        suggestedAction: `Update or replace stale ${claim.kind} claim '${claim.text}' in ${claim.file}:${claim.startLine}-${claim.endLine}.`,
        acceptanceCheck: {
          command: `${CODEFOG_COMMAND} verify ${claim.file} --lines ${claim.blockStartLine}-${claim.blockEndLine}`,
          criteria: [
            `Doc claim '${claim.text}' in ${claim.file}:${claim.blockStartLine}-${claim.blockEndLine} resolves to a valid referent`,
          ],
        },
      });
    }
  }

  const docTrustScore = computeTrustScore(docClaimsByState);

  return {
    docTrustScore,
    totalDocClaims: docClaims.length,
    docClaimsByState,
    docClaims,
    docFindings,
    parsedDocs,
  };
}
