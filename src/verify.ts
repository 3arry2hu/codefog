import * as fs from "node:fs/promises";
import * as path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import ts from "typescript";
import { analyzeTestAstEvidence, lookupFunctionAstEvidence } from "./ast-evidence.js";
import {
  analyzeDocClaims,
  buildRepoSymbolIndex,
  extractSymbolsFromSource,
  isInstructionFile,
  loadPackageManifestInfo,
  type DocBlock,
  type ParsedDocFile,
  type RepoSymbolIndex,
} from "./doc-claims.js";
import { createGitTimelineSession, type GitTimelineSession } from "./git-freshness.js";
import {
  extractPolyglotFunctionSpans,
  getPolyglotAdapter,
  isCompilerErrorOutput,
  isPolyglotSourceFile,
} from "./polyglot.js";
import { assessSymbolOracle, lastCommitHash, loadOracleBundle } from "./oracle.js";
import type { DeletedDocClaimEvent, DocClaim, DocReferent, SurvivingMutant } from "./types.js";

const execAsync = promisify(exec);

export interface VerifyOptions {
  rootDir: string;
  targetFile: string;
  mutants: boolean;
  startLine?: number;
  endLine?: number;
  testCmd?: string;
  allowSourceChange?: boolean;
  oracle?: boolean;
  expectationsPath?: string;
  defectsPath?: string;
  runDocs?: boolean;
  checkExternalLinks?: boolean;
}

export interface VerifyResult {
  passed: boolean;
  exitCode: number;
  summary: string;
  totalMutants: number;
  killedMutants: number;
  survivingMutants: SurvivingMutant[];
  violations: string[];
}

interface CandidateMutation {
  id: string;
  line: number;
  original: string;
  mutated: string;
  mutatedSource: string;
  isBodyClearance?: boolean;
}

function countControlFlowBranches(sourceText: string, fileName: string): number {
  if (isPolyglotSourceFile(fileName)) {
    const spans = extractPolyglotFunctionSpans(sourceText, fileName);
    return spans.reduce((acc, s) => acc + Math.max(0, s.cyclomaticComplexity - 1), 0);
  }
  const sf = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  let count = 0;
  function walk(node: ts.Node): void {
    switch (node.kind) {
      case ts.SyntaxKind.IfStatement:
      case ts.SyntaxKind.ConditionalExpression:
      case ts.SyntaxKind.SwitchStatement:
      case ts.SyntaxKind.CaseClause:
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement:
      case ts.SyntaxKind.CatchClause:
        count++;
        break;
      case ts.SyntaxKind.BinaryExpression: {
        const bin = node as ts.BinaryExpression;
        if (
          bin.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          bin.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          bin.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        ) {
          count++;
        }
        break;
      }
    }
    ts.forEachChild(node, walk);
  }
  walk(sf);
  return count;
}

function extractFunctionNamesInRange(
  sourceText: string,
  fileName: string,
  startLine?: number,
  endLine?: number,
): string[] {
  if (isPolyglotSourceFile(fileName)) {
    const spans = extractPolyglotFunctionSpans(sourceText, fileName);
    return spans
      .filter((s) => {
        if (startLine !== undefined && endLine !== undefined) {
          return !(s.endLine < startLine || s.startLine > endLine);
        }
        return true;
      })
      .map((s) => s.name);
  }
  const sf = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const names: string[] = [];

  function checkAndAdd(name: string, node: ts.Node): void {
    const fnStart = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const fnEnd = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    if (startLine !== undefined && endLine !== undefined) {
      if (fnEnd < startLine || fnStart > endLine) return;
    }
    names.push(name);
  }

  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name) {
      checkAndAdd(node.name.text, node);
      return;
    }
    if (ts.isMethodDeclaration(node) && node.name) {
      checkAndAdd(node.name.getText(sf), node);
      return;
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      checkAndAdd(node.name.text, node);
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return names;
}

export function generateCandidateMutations(
  sourceText: string,
  fileName: string,
  startLine?: number,
  endLine?: number,
): CandidateMutation[] {
  const polyAdapter = getPolyglotAdapter(fileName);
  if (polyAdapter) {
    return polyAdapter.generateCandidateMutations(sourceText, startLine, endLine);
  }
  const sf = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const candidates: CandidateMutation[] = [];
  let seq = 1;

  function inLineRange(node: ts.Node): { ok: boolean; line: number } {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    if (startLine !== undefined && line < startLine) return { ok: false, line };
    if (endLine !== undefined && line > endLine) return { ok: false, line };
    return { ok: true, line };
  }

  function addReplacement(node: ts.Node, replacement: string, line: number): void {
    const start = node.getStart(sf);
    const end = node.getEnd();
    const original = sourceText.slice(start, end);
    if (original === replacement) return;
    const mutatedSource = sourceText.slice(0, start) + replacement + sourceText.slice(end);
    candidates.push({
      id: `mut_${seq++}`,
      line,
      original,
      mutated: replacement,
      mutatedSource,
    });
  }

  const binaryMutatorMap: Partial<Record<ts.SyntaxKind, string[]>> = {
    [ts.SyntaxKind.GreaterThanEqualsToken]: [">", "<"],
    [ts.SyntaxKind.LessThanEqualsToken]: ["<", ">"],
    [ts.SyntaxKind.GreaterThanToken]: [">=", "<="],
    [ts.SyntaxKind.LessThanToken]: ["<=", ">="],
    [ts.SyntaxKind.EqualsEqualsEqualsToken]: ["!=="],
    [ts.SyntaxKind.ExclamationEqualsEqualsToken]: ["==="],
    [ts.SyntaxKind.EqualsEqualsToken]: ["!="],
    [ts.SyntaxKind.ExclamationEqualsToken]: ["=="],
    [ts.SyntaxKind.PlusToken]: ["-"],
    [ts.SyntaxKind.MinusToken]: ["+"],
    [ts.SyntaxKind.AsteriskToken]: ["/"],
    [ts.SyntaxKind.SlashToken]: ["*"],
    [ts.SyntaxKind.AmpersandAmpersandToken]: ["||"],
    [ts.SyntaxKind.BarBarToken]: ["&&"],
  };

  function visit(node: ts.Node): void {
    const { ok, line } = inLineRange(node);
    if (ok) {
      if (ts.isBinaryExpression(node)) {
        const replacements = binaryMutatorMap[node.operatorToken.kind];
        if (replacements) {
          const leftText = node.left.getText(sf);
          const rightText = node.right.getText(sf);
          for (const op of replacements) {
            addReplacement(node, `${leftText} ${op} ${rightText}`, line);
          }
        }
      } else if (node.kind === ts.SyntaxKind.TrueKeyword) {
        addReplacement(node, "false", line);
      } else if (node.kind === ts.SyntaxKind.FalseKeyword) {
        addReplacement(node, "true", line);
      } else if (
        (ts.isFunctionDeclaration(node) ||
          ts.isMethodDeclaration(node) ||
          ts.isArrowFunction(node) ||
          ts.isFunctionExpression(node)) &&
        node.body
      ) {
        // Method/function body clearance check (Pseudo-tested method detector)
        const bodyLine = sf.getLineAndCharacterOfPosition(node.body.getStart(sf)).line + 1;
        if (ts.isBlock(node.body) && node.body.statements.length > 0) {
          addReplacement(node.body, "{ return undefined as any; }", bodyLine);
        } else if (!ts.isBlock(node.body)) {
          addReplacement(node.body, "(undefined as any)", bodyLine);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return candidates;
}

async function runCommandOutcome(
  cmd: string,
  cwd: string,
): Promise<{ passed: boolean; compilerError: boolean }> {
  try {
    await execAsync(cmd, { cwd, timeout: 30_000 });
    return { passed: true, compilerError: false };
  } catch (err: any) {
    const combinedOutput = `${err?.stdout ?? ""}\n${err?.stderr ?? ""}\n${err?.message ?? ""}`;
    return {
      passed: false,
      compilerError: isCompilerErrorOutput(combinedOutput),
    };
  }
}

async function runCommandPasses(cmd: string, cwd: string): Promise<boolean> {
  const res = await runCommandOutcome(cmd, cwd);
  return res.passed;
}

async function checkAntiGamingSourceIntegrity(
  rootDir: string,
  relTarget: string,
  currentSource: string,
): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`git show HEAD:${relTarget}`, { cwd: rootDir });
    if (!stdout) return null;
    const headBranches = countControlFlowBranches(stdout, relTarget);
    const currentBranches = countControlFlowBranches(currentSource, relTarget);
    if (currentBranches < headBranches) {
      return `Anti-gaming gate triggered: business source file ${relTarget} was modified and lost control-flow branches (${headBranches} -> ${currentBranches} branches compared to HEAD). Pass --allow-source-change if this refactoring is intentional.`;
    }
  } catch {
    // Not in git or file not in HEAD yet
  }
  return null;
}

async function detectDefaultTestCommand(
  rootDir: string,
  associatedTestFiles: string[],
  targetFile = "",
): Promise<string> {
  const polyAdapter = getPolyglotAdapter(targetFile);
  if (polyAdapter) {
    return polyAdapter.defaultTestCommand(rootDir, associatedTestFiles);
  }
  const testTargets = associatedTestFiles.length > 0 ? ` ${associatedTestFiles.join(" ")}` : "";
  try {
    const pkgRaw = await fs.readFile(path.join(rootDir, "package.json"), "utf8");
    const pkg = JSON.parse(pkgRaw) as {
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.vitest || pkg.scripts?.test?.includes("vitest")) {
      return `npx vitest run${testTargets}`;
    }
    if (deps.jest || pkg.scripts?.test?.includes("jest")) {
      return `npx jest${testTargets}`;
    }
  } catch {
    // Fallback below
  }
  return `node --test${testTargets}`;
}

export function isDocVerifyTarget(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, "/");
  return /\.(?:md|mdc|markdown)$/i.test(norm) || isInstructionFile(norm);
}

interface AlignedBlockHunk {
  headBlocks: DocBlock[];
  curBlocks: DocBlock[];
}

export function alignDocBlockHunks(
  headDoc: ParsedDocFile,
  curDoc: ParsedDocFile,
): AlignedBlockHunk[] {
  const H = headDoc.blocks.filter((b) => !b.ignored);
  const C = curDoc.blocks.filter((b) => !b.ignored);
  const m = H.length;
  const n = C.length;

  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (H[i]!.kind === C[j]!.kind && H[i]!.normalizedText === C[j]!.normalizedText) {
        dp[i]![j] = 1 + dp[i + 1]![j + 1]!;
      } else {
        dp[i]![j] = Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
      }
    }
  }

  const anchors: Array<{ hi: number; ci: number }> = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (H[i]!.kind === C[j]!.kind && H[i]!.normalizedText === C[j]!.normalizedText) {
      anchors.push({ hi: i, ci: j });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      i++;
    } else {
      j++;
    }
  }

  const hunks: AlignedBlockHunk[] = [];
  let prevH = 0;
  let prevC = 0;
  for (const anchor of anchors) {
    if (anchor.hi > prevH || anchor.ci > prevC) {
      hunks.push({
        headBlocks: H.slice(prevH, anchor.hi),
        curBlocks: C.slice(prevC, anchor.ci),
      });
    }
    prevH = anchor.hi + 1;
    prevC = anchor.ci + 1;
  }
  if (prevH < m || prevC < n) {
    hunks.push({
      headBlocks: H.slice(prevH, m),
      curBlocks: C.slice(prevC, n),
    });
  }

  return hunks;
}

async function findHistoricalSiblingSymbols(
  gitSession: GitTimelineSession,
  file: string,
  targetSymbol: string,
): Promise<Set<string>> {
  if (!gitSession.isGitRepo) return new Set();
  const commits = await gitSession.getFileCommits(file);
  for (const c of commits) {
    const text = await gitSession.getFileTextAtCommit(c.sha, file);
    if (!text) continue;
    const syms = extractSymbolsFromSource(text, file);
    if (syms.some((s) => s.name === targetSymbol)) {
      return new Set(syms.filter((s) => s.name !== targetSymbol).map((s) => s.name));
    }
  }
  return new Set();
}

function normalizeFingerprintForRename(fp: string, symbolName: string): string {
  let normalized = fp;
  if (normalized.startsWith(`${symbolName}:`)) {
    normalized = normalized.slice(symbolName.length + 1);
  }
  const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return normalized.replace(new RegExp(`\\b${escaped}\\b`, "g"), "__SELF__");
}

async function resolveExistingReferentsForClaim(
  claim: DocClaim,
  symbolIndex: RepoSymbolIndex,
  gitSession: GitTimelineSession,
  rootDir: string,
  pkgInfo: Awaited<ReturnType<typeof loadPackageManifestInfo>>,
  curDoc?: ParsedDocFile,
): Promise<DocReferent[]> {
  const refs =
    claim.referents.length > 0
      ? claim.referents
      : claim.referent
        ? [claim.referent]
        : [];
  const active: DocReferent[] = [];

  for (const ref of refs) {
    if (ref.kind === "symbol") {
      const symName = ref.symbol ?? claim.text;
      const byName =
        symbolIndex.byQualifiedName.get(symName) ??
        symbolIndex.byName.get(symName) ??
        [];
      const inSameFile = ref.file ? byName.filter((s) => s.file === ref.file) : [];
      const matched = inSameFile.length > 0 ? inSameFile : byName;
      if (matched.length > 0) {
        for (const s of matched) {
          active.push({
            kind: "symbol",
            file: s.file,
            symbol: s.name,
            startLine: s.startLine,
            endLine: s.endLine,
            runtimeFingerprint: s.runtimeFingerprint,
          });
        }
        continue;
      }

      // Check if symbol was renamed in ref.file (using runtimeFingerprint identity, never line overlap alone)
      if (ref.file && ref.runtimeFingerprint) {
        const curFileSyms = symbolIndex.byFile.get(ref.file) ?? [];
        const histSiblings = await findHistoricalSiblingSymbols(gitSession, ref.file, symName);
        const newSymsInFile = curFileSyms.filter((s) => !histSiblings.has(s.name));
        const targetNormFp = normalizeFingerprintForRename(ref.runtimeFingerprint, symName);

        const fpMatches = newSymsInFile.filter(
          (s) =>
            normalizeFingerprintForRename(s.runtimeFingerprint, s.name) === targetNormFp,
        );
        if (fpMatches.length > 0) {
          for (const s of fpMatches) {
            active.push({
              kind: "symbol",
              file: s.file,
              symbol: s.name,
              startLine: s.startLine,
              endLine: s.endLine,
              runtimeFingerprint: s.runtimeFingerprint,
            });
          }
          continue;
        }
      }
    } else if (ref.kind === "script" && ref.script) {
      if (pkgInfo.scripts.has(ref.script)) {
        active.push({
          kind: "script",
          file: "package.json",
          script: ref.script,
          scriptDefinition: pkgInfo.scripts.get(ref.script),
        });
      }
    } else if (ref.kind === "file" && ref.file) {
      try {
        await fs.access(path.join(rootDir, ref.file));
        active.push({ kind: "file", file: ref.file });
      } catch {
        // file deleted
      }
    } else if (ref.kind === "bin" && ref.bin) {
      const binOk =
        pkgInfo.binNames.has(ref.bin) &&
        (!ref.subcommand || pkgInfo.binSubcommands.has(ref.subcommand));
      if (binOk) {
        active.push(ref);
      }
    } else if (ref.kind === "anchor" && ref.anchor) {
      if (curDoc?.headings.some((h) => h.slug === ref.anchor)) {
        active.push(ref);
      }
    }
  }

  return active;
}

function claimMatchesAnyReferent(claim: DocClaim, targets: DocReferent[]): boolean {
  const claimRefs =
    claim.referents.length > 0
      ? claim.referents
      : claim.referent
        ? [claim.referent]
        : [];
  for (const cr of claimRefs) {
    for (const tr of targets) {
      if (cr.kind !== tr.kind) continue;
      if (cr.kind === "symbol" && cr.file === tr.file && cr.symbol === tr.symbol) {
        return true;
      }
      if (cr.kind === "file" && cr.file === tr.file) {
        return true;
      }
      if (cr.kind === "script" && cr.script === tr.script) {
        return true;
      }
      if (cr.kind === "bin" && cr.bin === tr.bin && cr.subcommand === tr.subcommand) {
        return true;
      }
      if (cr.kind === "anchor" && cr.anchor === tr.anchor) {
        return true;
      }
    }
  }
  return false;
}

export async function verifyDocTarget(options: VerifyOptions): Promise<VerifyResult> {
  const rootDir = path.resolve(options.rootDir);
  const absTarget = path.resolve(rootDir, options.targetFile);
  const relTarget = path.relative(rootDir, absTarget).replace(/\\/g, "/");

  const [gitSession, curSymbolIndex, pkgInfo] = await Promise.all([
    createGitTimelineSession(rootDir),
    buildRepoSymbolIndex(rootDir),
    loadPackageManifestInfo(rootDir),
  ]);

  const headText = gitSession.isGitRepo
    ? await gitSession.getFileTextAtCommit("HEAD", relTarget)
    : null;

  const [headAnalysis, curAnalysis] = await Promise.all([
    headText !== null
      ? analyzeDocClaims({
          rootDir,
          docFileOverrides: new Map([[relTarget, headText]]),
          extraDocFiles: [relTarget],
        })
      : Promise.resolve(null),
    analyzeDocClaims({
      rootDir,
      runDocs: options.runDocs,
      checkExternalLinks: options.checkExternalLinks,
      extraDocFiles: [relTarget],
    }),
  ]);

  const curDoc = curAnalysis.parsedDocs.find((d) => d.file === relTarget);
  const headDoc = headAnalysis?.parsedDocs.find((d) => d.file === relTarget);
  const curFileClaims = curAnalysis.docClaims.filter((c) => c.file === relTarget);
  const headFileClaims = (headAnalysis?.docClaims ?? []).filter((c) => c.file === relTarget);

  const violations: string[] = [];

  const inRange = (start: number, end: number): boolean => {
    if (options.startLine !== undefined && end < options.startLine) return false;
    if (options.endLine !== undefined && start > options.endLine) return false;
    return true;
  };

  if (!options.allowSourceChange && gitSession.isGitRepo) {
    const referentFiles = new Set<string>();
    for (const c of [...headFileClaims, ...curFileClaims]) {
      if (!inRange(c.blockStartLine, c.blockEndLine) && !inRange(c.startLine, c.endLine)) {
        continue;
      }
      const refs =
        c.referents.length > 0 ? c.referents : c.referent ? [c.referent] : [];
      for (const r of refs) {
        if (
          r.file &&
          r.file !== relTarget &&
          r.kind !== "generated-artifact" &&
          !isDocVerifyTarget(r.file)
        ) {
          referentFiles.add(r.file);
        }
      }
    }

    for (const refFile of Array.from(referentFiles).sort()) {
      const headRefText = await gitSession.getFileTextAtCommit("HEAD", refFile);
      let curRefText: string | null = null;
      try {
        curRefText = (await fs.readFile(path.join(rootDir, refFile), "utf8")).trim();
      } catch {
        curRefText = null;
      }
      if (headRefText === null ? curRefText !== null : curRefText !== headRefText.trim()) {
        violations.push(
          `Anti-gaming gate triggered: referent source file '${refFile}' has uncommitted changes relative to HEAD while verifying ${relTarget}. Pass --allow-source-change if modifying source code is intentional.`,
        );
      }
    }
  }

  if (headDoc && curDoc) {
    const hunks = alignDocBlockHunks(headDoc, curDoc);
    const checkedClaimIds = new Set<string>();

    for (const hunk of hunks) {
      const hunkInRange =
        hunk.headBlocks.some((b) => inRange(b.startLine, b.endLine)) ||
        hunk.curBlocks.some((b) => inRange(b.startLine, b.endLine));
      if (!hunkInRange) continue;

      const pairCount =
        hunk.headBlocks.length === hunk.curBlocks.length ? hunk.headBlocks.length : 0;

      for (let idx = 0; idx < hunk.headBlocks.length; idx++) {
        const hb = hunk.headBlocks[idx]!;
        const pairedCurBlocks =
          pairCount > 0 ? [hunk.curBlocks[idx]!] : hunk.curBlocks;
        if (
          !inRange(hb.startLine, hb.endLine) &&
          !pairedCurBlocks.some((cb) => inRange(cb.startLine, cb.endLine))
        ) {
          continue;
        }

        const hbClaims = headFileClaims.filter(
          (c) => c.blockStartLine === hb.startLine && c.blockEndLine === hb.endLine,
        );
        const cbClaims = curFileClaims.filter((c) =>
          pairedCurBlocks.some(
            (cb) => c.blockStartLine === cb.startLine && c.blockEndLine === cb.endLine,
          ),
        );

        for (const hc of hbClaims) {
          if (hc.state !== "fog-returned") continue;
          const activeRefs = await resolveExistingReferentsForClaim(
            hc,
            curSymbolIndex,
            gitSession,
            rootDir,
            pkgInfo,
            curDoc,
          );
          if (activeRefs.length === 0) {
            if (hc.kind === "symbol") {
              const retainedDeadClaim = cbClaims.find(
                (cc) =>
                  cc.kind === "symbol" &&
                  (cc.text === hc.text || cc.rawText === hc.rawText),
              );
              if (retainedDeadClaim && !checkedClaimIds.has(retainedDeadClaim.id)) {
                checkedClaimIds.add(retainedDeadClaim.id);
                violations.push(
                  `Unresolvable doc claim '${retainedDeadClaim.text}' (${retainedDeadClaim.kind}) in modified block at ${relTarget}:${retainedDeadClaim.startLine}.`,
                );
              }
            }
            continue;
          }

          const kept = cbClaims.some(
            (cc) => cc.state !== "fog-returned" && claimMatchesAnyReferent(cc, activeRefs),
          );
          if (!kept) {
            const refDesc = activeRefs
              .map((r) => (r.file && r.symbol ? `${r.file} (${r.symbol})` : r.file ?? r.symbol ?? hc.text))
              .join(", ");
            violations.push(
              `Anti-gaming gate triggered: fog-returned doc claim '${hc.text}' at ${relTarget}:${hc.startLine} was deleted or rewritten into vague text while referent ${refDesc} still exists.`,
            );
          }
        }
      }

      // Rule 3: All claims in modified blocks must be resolvable (and code blocks must pass under --run-docs)
      for (const cb of hunk.curBlocks) {
        if (!inRange(cb.startLine, cb.endLine)) continue;
        const cbClaims = curFileClaims.filter(
          (c) => c.blockStartLine === cb.startLine && c.blockEndLine === cb.endLine,
        );
        for (const cc of cbClaims) {
          if (cc.state === "fog-returned" && !checkedClaimIds.has(cc.id)) {
            checkedClaimIds.add(cc.id);
            if (cc.kind === "code-block" && cc.executionOutput) {
              violations.push(
                `Doc code block at ${relTarget}:${cc.startLine}-${cc.endLine} failed execution: ${cc.executionOutput}`,
              );
            } else {
              violations.push(
                `Unresolvable doc claim '${cc.text}' (${cc.kind}) in modified block at ${relTarget}:${cc.startLine}.`,
              );
            }
          }
        }
      }
    }

    if (options.runDocs) {
      for (const cc of curFileClaims) {
        if (
          cc.kind === "code-block" &&
          cc.state === "fog-returned" &&
          inRange(cc.blockStartLine, cc.blockEndLine) &&
          !checkedClaimIds.has(cc.id)
        ) {
          checkedClaimIds.add(cc.id);
          violations.push(
            `Doc code block at ${relTarget}:${cc.startLine}-${cc.endLine} failed execution: ${cc.executionOutput ?? "execution failed"}`,
          );
        }
      }
    }

    for (const cc of curFileClaims) {
      if (
        cc.state === "fog-returned" &&
        inRange(cc.blockStartLine, cc.blockEndLine) &&
        !checkedClaimIds.has(cc.id)
      ) {
        checkedClaimIds.add(cc.id);
        violations.push(
          `Unresolved or fog-returned doc claim '${cc.text}' (${cc.kind}) at ${relTarget}:${cc.startLine}.`,
        );
      }
    }
  } else {
    for (const cc of curFileClaims) {
      if (cc.state === "fog-returned" && inRange(cc.blockStartLine, cc.blockEndLine)) {
        violations.push(
          `Unresolvable doc claim '${cc.text}' (${cc.kind}) at ${relTarget}:${cc.startLine}.`,
        );
      }
    }
  }

  if (violations.length > 0) {
    return {
      passed: false,
      exitCode: 1,
      summary:
        `Verification FAILED for ${relTarget}:\n` +
        violations.map((v) => `  - ${v}`).join("\n"),
      totalMutants: 0,
      killedMutants: 0,
      survivingMutants: [],
      violations,
    };
  }

  return {
    passed: true,
    exitCode: 0,
    summary: `VERIFIED ${relTarget}: All doc verification gates passed.`,
    totalMutants: 0,
    killedMutants: 0,
    survivingMutants: [],
    violations: [],
  };
}

export async function detectDeletedDocClaimsAgainstRef(
  rootDir: string,
  baseRef: string,
): Promise<DeletedDocClaimEvent[]> {
  const absRoot = path.resolve(rootDir);
  const [gitSession, curSymbolIndex, pkgInfo, curAnalysis] = await Promise.all([
    createGitTimelineSession(absRoot),
    buildRepoSymbolIndex(absRoot),
    loadPackageManifestInfo(absRoot),
    analyzeDocClaims({ rootDir: absRoot }),
  ]);

  if (!gitSession.isGitRepo) return [];

  const overrides = new Map<string, string>();
  for (const curDoc of curAnalysis.parsedDocs) {
    const baseText = await gitSession.getFileTextAtCommit(baseRef, curDoc.file);
    if (baseText !== null && baseText !== curDoc.content) {
      overrides.set(curDoc.file, baseText);
    }
  }

  if (overrides.size === 0) return [];

  const baseAtCurrentAnalysis = await analyzeDocClaims({
    rootDir: absRoot,
    docFileOverrides: overrides,
  });

  const deletedEvents: DeletedDocClaimEvent[] = [];
  const seenKeys = new Set<string>();

  for (const [docFile] of overrides.entries()) {
    const baseDoc = baseAtCurrentAnalysis.parsedDocs.find((d) => d.file === docFile);
    const curDoc = curAnalysis.parsedDocs.find((d) => d.file === docFile);
    if (!baseDoc || !curDoc) continue;

    const baseFileClaims = baseAtCurrentAnalysis.docClaims.filter((c) => c.file === docFile);
    const curFileClaims = curAnalysis.docClaims.filter((c) => c.file === docFile);
    const hunks = alignDocBlockHunks(baseDoc, curDoc);

    for (const hunk of hunks) {
      const pairCount =
        hunk.headBlocks.length === hunk.curBlocks.length ? hunk.headBlocks.length : 0;

      for (let idx = 0; idx < hunk.headBlocks.length; idx++) {
        const hb = hunk.headBlocks[idx]!;
        const pairedCurBlocks =
          pairCount > 0 ? [hunk.curBlocks[idx]!] : hunk.curBlocks;

        const hbClaims = baseFileClaims.filter(
          (c) => c.blockStartLine === hb.startLine && c.blockEndLine === hb.endLine,
        );
        const cbClaims = curFileClaims.filter((c) =>
          pairedCurBlocks.some(
            (cb) => c.blockStartLine === cb.startLine && c.blockEndLine === cb.endLine,
          ),
        );

        for (const hc of hbClaims) {
          if (hc.state !== "fog-returned") continue;
          const activeRefs = await resolveExistingReferentsForClaim(
            hc,
            curSymbolIndex,
            gitSession,
            absRoot,
            pkgInfo,
            curDoc,
          );
          if (activeRefs.length === 0) continue;

          const kept = cbClaims.some(
            (cc) => cc.state !== "fog-returned" && claimMatchesAnyReferent(cc, activeRefs),
          );
          if (!kept) {
            const dedupKey = `${hc.file}:${hc.startLine}:${hc.rawText}`;
            if (!seenKeys.has(dedupKey)) {
              seenKeys.add(dedupKey);
              deletedEvents.push({
                file: hc.file,
                claimText: hc.text,
                rawText: hc.rawText,
                kind: hc.kind,
                line: hc.startLine,
                referent: activeRefs[0]!,
              });
            }
          }
        }
      }
    }
  }

  return deletedEvents;
}

export async function verifyTargetWithMutants(options: VerifyOptions): Promise<VerifyResult> {
  if (isDocVerifyTarget(options.targetFile)) {
    return verifyDocTarget(options);
  }
  const rootDir = path.resolve(options.rootDir);
  const absTarget = path.resolve(rootDir, options.targetFile);
  const relTarget = path.relative(rootDir, absTarget).replace(/\\/g, "/");

  const originalSource = await fs.readFile(absTarget, "utf8");
  const violations: string[] = [];

  // Gate 1: Anti-gaming check against deleting business source branches
  if (!options.allowSourceChange) {
    const branchViolation = await checkAntiGamingSourceIntegrity(
      rootDir,
      relTarget,
      originalSource,
    );
    if (branchViolation) {
      violations.push(branchViolation);
    }
  }

  // Gate 2: AST outcome assertion check on target functions
  const astResult = await analyzeTestAstEvidence(rootDir);
  const targetFns = extractFunctionNamesInRange(
    originalSource,
    relTarget,
    options.startLine,
    options.endLine,
  );
  const associatedTestFiles = new Set<string>();
  for (const fnName of targetFns) {
    const ev = lookupFunctionAstEvidence(astResult, relTarget, fnName);
    if (ev) {
      for (const tf of ev.testFiles) associatedTestFiles.add(tf);
    }
    if (!ev || ev.assertionsOnOutcome === 0) {
      violations.push(
        `Anti-gaming gate triggered: function '${fnName}' in ${relTarget} has 0 outcome assertions in tests (pseudo-tested or untested).`,
      );
    }
  }

  if (options.oracle) {
    const bundle = await loadOracleBundle(rootDir, {
      expectationsPath: options.expectationsPath,
      defectsPath: options.defectsPath,
    });
    const sourceCommit = await lastCommitHash(rootDir, relTarget);
    for (const fnName of targetFns) {
      const ev = lookupFunctionAstEvidence(astResult, relTarget, fnName);
      const verdict = await assessSymbolOracle({
        rootDir,
        file: relTarget,
        symbol: fnName,
        testFiles: ev?.testFiles ?? [],
        bundle,
        sourceCommit,
      });
      if (verdict.contested) {
        violations.push(
          `Oracle contest: outcome assertion for '${fnName}' contradicts ${verdict.contestIds.join(", ")}. Do not rewrite the assertion literal to the current return value.`,
        );
      }
    }
  }

  if (violations.length > 0) {
    return {
      passed: false,
      exitCode: 1,
      summary: `Verification FAILED for ${relTarget}:\n` + violations.map((v) => `  - ${v}`).join("\n"),
      totalMutants: 0,
      killedMutants: 0,
      survivingMutants: [],
      violations,
    };
  }

  const testCmd =
    options.testCmd ??
    (await detectDefaultTestCommand(rootDir, Array.from(associatedTestFiles), relTarget));

  // First ensure baseline tests pass on unmodified source
  const baselinePass = await runCommandPasses(testCmd, rootDir);
  if (!baselinePass) {
    const msg = `Baseline test command failed before mutation testing: ${testCmd}`;
    return {
      passed: false,
      exitCode: 1,
      summary: msg,
      totalMutants: 0,
      killedMutants: 0,
      survivingMutants: [],
      violations: [msg],
    };
  }

  // Gate 3: Targeted mutation verification (runs full operator + body clearance mutants when --mutants is set, or body clearance check by default)
  const allCandidates = generateCandidateMutations(
    originalSource,
    relTarget,
    options.startLine,
    options.endLine,
  );
  const candidates = options.mutants
    ? allCandidates
    : allCandidates.filter(
        (c) => Boolean(c.isBodyClearance) || c.mutated.includes("undefined as any"),
      );

  const survivingMutants: SurvivingMutant[] = [];
  let killedMutants = 0;
  let validMutantsCount = 0;

  try {
    for (const candidate of candidates) {
      await fs.writeFile(absTarget, candidate.mutatedSource, "utf8");
      const outcome = await runCommandOutcome(testCmd, rootDir);
      if (outcome.compilerError) {
        // Exempt CompileError mutants so they are neither counted as killed nor surviving
        continue;
      }
      validMutantsCount++;
      if (outcome.passed) {
        survivingMutants.push({
          id: candidate.id,
          line: candidate.line,
          original: candidate.original,
          mutated: candidate.mutated,
          testsRun: 1,
          killed: false,
        });
      } else {
        killedMutants++;
      }
    }
  } finally {
    // Always restore original file content!
    await fs.writeFile(absTarget, originalSource, "utf8");
  }

  if (survivingMutants.length > 0) {
    for (const sm of survivingMutants) {
      violations.push(
        `Surviving mutant [${sm.id}] at ${relTarget}:${sm.line}: '${sm.original}' -> '${sm.mutated}' survived test suite.`,
      );
    }
    return {
      passed: false,
      exitCode: 1,
      summary:
        `Verification FAILED for ${relTarget}: ${survivingMutants.length} mutant(s) survived (${killedMutants}/${validMutantsCount} killed).\n` +
        violations.map((v) => `  - ${v}`).join("\n"),
      totalMutants: validMutantsCount,
      killedMutants,
      survivingMutants,
      violations,
    };
  }

  return {
    passed: true,
    exitCode: 0,
    summary: `VERIFIED ${relTarget}: All ${killedMutants}/${validMutantsCount} mutants killed and anti-gaming gates passed.`,
    totalMutants: validMutantsCount,
    killedMutants,
    survivingMutants: [],
    violations: [],
  };
}
