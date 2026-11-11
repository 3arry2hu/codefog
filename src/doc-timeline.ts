import { parseMarkdownDoc, type DocBlock, type ParsedDocFile } from "./doc-markdown.js";
import {
  addSymbolToIndex,
  extractSubcommandsFromCliSource,
  extractSymbolsFromSource,
  isRepoSourceFile,
  type PackageManifestInfo,
  type RepoSymbol,
  type RepoSymbolIndex,
} from "./doc-resolution.js";
import type { GitTimelineSession, RepoCommitInfo } from "./git-freshness.js";
import { isIgnoredRepoRelPath } from "./polyglot.js";

/**
 * Discriminated union representing either an uncommitted working-tree change
 * or a historical Git commit on the repository timeline.
 */
export type DocTimelinePoint =
  | {
      readonly kind: "worktree";
      readonly shortSha: string;
      readonly isoDate: string;
    }
  | {
      readonly kind: "commit";
      readonly commit: RepoCommitInfo;
      readonly shortSha: string;
      readonly isoDate: string;
    };

function toCommitPoint(commit: RepoCommitInfo): DocTimelinePoint {
  return {
    kind: "commit",
    commit,
    shortSha: commit.shortSha,
    isoDate: commit.isoDate,
  };
}

function toWorktreePoint(gitSession: GitTimelineSession): DocTimelinePoint {
  return {
    kind: "worktree",
    shortSha: gitSession.commits[0]?.shortSha ?? "0000000",
    isoDate: new Date().toISOString(),
  };
}

function timelineOrdinal(point: DocTimelinePoint): number {
  return point.kind === "worktree" ? -1 : point.commit.index;
}

/**
 * Returns true when the referent changed more recently than the doc block's
 * last substantive edit.
 */
export function isReferentNewerThanBlock(
  referentPoint: DocTimelinePoint | null,
  blockPoint: DocTimelinePoint | null,
): boolean {
  if (!referentPoint || !blockPoint) return false;
  return timelineOrdinal(referentPoint) < timelineOrdinal(blockPoint);
}

/**
 * Resolves the commit SHA to inspect when checking whether a referent existed
 * at the doc block's last substantive edit.
 */
export function getLookupCommitSha(
  blockPoint: DocTimelinePoint | null,
  gitSession: GitTimelineSession,
): string | undefined {
  if (!blockPoint) return undefined;
  return blockPoint.kind === "worktree"
    ? gitSession.commits[0]?.sha
    : blockPoint.commit.sha;
}

export interface DocTimelineOracle {
  getParsedDocAtCommit(sha: string, relPath: string): Promise<ParsedDocFile | null>;
  getFileSymbolsAtCommit(sha: string, relPath: string): Promise<RepoSymbol[]>;
  getPackageManifestAtCommit(sha: string): Promise<PackageManifestInfo>;
  getPackageScriptsAtCommit(sha: string): Promise<Map<string, string>>;
  getSymbolIndexAtCommit(sha: string): Promise<RepoSymbolIndex>;
  findScriptLastChangePoint(scriptName: string, currentDef: string): Promise<DocTimelinePoint | null>;
  findFileLatestPoint(relPath: string): Promise<DocTimelinePoint | null>;
  findSymbolRemovalPoint(sym: RepoSymbol): Promise<DocTimelinePoint | null>;
  findBlockLastSubstantivePoint(docFile: string, block: DocBlock): Promise<DocTimelinePoint | null>;
  findSymbolLastRuntimeChangePoint(sym: RepoSymbol): Promise<DocTimelinePoint | null>;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

export function createDocTimelineOracle(
  gitSession: GitTimelineSession,
  docFileOverrides?: Map<string, string>,
): DocTimelineOracle {
  const parsedDocAtCommitCache = new Map<string, Promise<ParsedDocFile | null>>();
  const symbolsAtCommitCache = new Map<string, Promise<RepoSymbol[]>>();
  const symbolIndexAtCommitCache = new Map<string, Promise<RepoSymbolIndex>>();
  const pkgManifestAtCommitCache = new Map<string, Promise<PackageManifestInfo>>();

  function getParsedDocAtCommit(sha: string, relPath: string): Promise<ParsedDocFile | null> {
    const key = `${sha}:${relPath}`;
    let p = parsedDocAtCommitCache.get(key);
    if (!p) {
      p = (async () => {
        const text = await gitSession.getFileTextAtCommit(sha, relPath);
        if (text === null) return null;
        return parseMarkdownDoc(relPath, text);
      })();
      parsedDocAtCommitCache.set(key, p);
    }
    return p;
  }

  function getFileSymbolsAtCommit(sha: string, relPath: string): Promise<RepoSymbol[]> {
    const key = `${sha}:${relPath}`;
    let p = symbolsAtCommitCache.get(key);
    if (!p) {
      p = (async () => {
        const text = await gitSession.getFileTextAtCommit(sha, relPath);
        if (text === null) return [];
        return extractSymbolsFromSource(text, relPath);
      })();
      symbolsAtCommitCache.set(key, p);
    }
    return p;
  }

  function getPackageManifestAtCommit(sha: string): Promise<PackageManifestInfo> {
    let p = pkgManifestAtCommitCache.get(sha);
    if (!p) {
      p = (async () => {
        const scripts = new Map<string, string>();
        const binNames = new Set<string>();
        const binFiles: string[] = [];
        const binSubcommands = new Set<string>();
        const raw = await gitSession.getFileTextAtCommit(sha, "package.json");
        if (!raw) {
          return {
            hasPackageJson: false,
            scripts,
            binNames,
            binFiles,
            binSubcommands,
          };
        }
        let parsed: {
          name?: string;
          scripts?: Record<string, string>;
          bin?: string | Record<string, string>;
        } = {};
        try {
          parsed = JSON.parse(raw) as typeof parsed;
        } catch {
          return {
            hasPackageJson: false,
            scripts,
            binNames,
            binFiles,
            binSubcommands,
          };
        }
        if (parsed.scripts && typeof parsed.scripts === "object") {
          for (const [k, v] of Object.entries(parsed.scripts)) {
            if (typeof v === "string") {
              scripts.set(k, v);
            }
          }
        }
        const pkgName = typeof parsed.name === "string" ? parsed.name : undefined;
        if (typeof parsed.bin === "string") {
          if (pkgName) {
            const shortName = pkgName.replace(/^@[^/]+\//, "");
            binNames.add(shortName);
            binNames.add(pkgName);
          }
          binFiles.push(toPosix(parsed.bin).replace(/^\.\//, ""));
        } else if (parsed.bin && typeof parsed.bin === "object") {
          for (const [bName, bPath] of Object.entries(parsed.bin)) {
            binNames.add(bName);
            if (typeof bPath === "string") {
              binFiles.push(toPosix(bPath).replace(/^\.\//, ""));
            }
          }
          if (pkgName) {
            binNames.add(pkgName);
          }
        }
        if (binNames.has("codefog")) {
          for (const builtin of ["verify", "install-skill", "skill", "init-skill"]) {
            binSubcommands.add(builtin);
          }
        }
        const candidateCliFiles = new Set<string>([
          ...binFiles,
          "src/cli.ts",
          "src/bin.ts",
        ]);
        for (const rel of candidateCliFiles) {
          const cliSrc = await gitSession.getFileTextAtCommit(sha, rel);
          if (cliSrc) {
            for (const sub of extractSubcommandsFromCliSource(cliSrc, binNames)) {
              binSubcommands.add(sub);
            }
          }
        }
        return {
          hasPackageJson: true,
          packageName: pkgName,
          scripts,
          binNames,
          binFiles,
          binSubcommands,
        };
      })();
      pkgManifestAtCommitCache.set(sha, p);
    }
    return p;
  }

  async function getPackageScriptsAtCommit(sha: string): Promise<Map<string, string>> {
    const manifest = await getPackageManifestAtCommit(sha);
    return manifest.scripts;
  }

  async function findScriptLastChangePoint(
    scriptName: string,
    currentDef: string,
  ): Promise<DocTimelinePoint | null> {
    if (!gitSession.isGitRepo) return null;
    const pkgCommits = await gitSession.getFileCommits("package.json");
    if (pkgCommits.length === 0) {
      return toWorktreePoint(gitSession);
    }

    const headScripts = await getPackageScriptsAtCommit(pkgCommits[0]!.sha);
    if (headScripts.get(scriptName) !== currentDef) {
      return toWorktreePoint(gitSession);
    }

    for (let i = 0; i < pkgCommits.length; i++) {
      const cur = pkgCommits[i]!;
      const next = pkgCommits[i + 1];
      if (!next) return toCommitPoint(cur);
      const nextScripts = await getPackageScriptsAtCommit(next.sha);
      if (nextScripts.get(scriptName) !== currentDef) {
        return toCommitPoint(cur);
      }
    }

    return toCommitPoint(pkgCommits[pkgCommits.length - 1]!);
  }

  async function findFileLatestPoint(relPath: string): Promise<DocTimelinePoint | null> {
    if (!gitSession.isGitRepo) return null;
    const commits = await gitSession.getFileCommits(relPath);
    return commits[0] ? toCommitPoint(commits[0]) : null;
  }

  function getSymbolIndexAtCommit(sha: string): Promise<RepoSymbolIndex> {
    let p = symbolIndexAtCommitCache.get(sha);
    if (!p) {
      p = (async () => {
        const tracked = await gitSession.listTrackedFilesAtCommit(sha);
        const byName = new Map<string, RepoSymbol[]>();
        const byQualifiedName = new Map<string, RepoSymbol[]>();
        const byFile = new Map<string, RepoSymbol[]>();

        const sortedFiles = Array.from(tracked)
          .filter((rel) => isRepoSourceFile(rel) && !isIgnoredRepoRelPath(rel))
          .sort((a, b) => a.localeCompare(b));

        for (const relPath of sortedFiles) {
          const fileSyms = await getFileSymbolsAtCommit(sha, relPath);
          byFile.set(relPath, fileSyms);
          for (const sym of fileSyms) {
            addSymbolToIndex(sym, byName, byQualifiedName);
          }
        }

        return { byName, byQualifiedName, byFile };
      })();
      symbolIndexAtCommitCache.set(sha, p);
    }
    return p;
  }

  async function findSymbolRemovalPoint(sym: RepoSymbol): Promise<DocTimelinePoint | null> {
    if (!gitSession.isGitRepo) return null;
    const fileCommits = await gitSession.getFileCommits(sym.file);
    if (fileCommits.length === 0) {
      return gitSession.commits[0] ? toCommitPoint(gitSession.commits[0]) : null;
    }

    const matchSym = (list: RepoSymbol[]): RepoSymbol | undefined =>
      sym.qualifiedName
        ? list.find((s) => s.qualifiedName === sym.qualifiedName) ??
          list.find((s) => s.name === sym.name)
        : list.find((s) => s.name === sym.name);

    for (let i = 0; i < fileCommits.length; i++) {
      const cur = fileCommits[i]!;
      const next = fileCommits[i + 1];
      if (!next) return toCommitPoint(cur);
      const nextSyms = await getFileSymbolsAtCommit(next.sha, sym.file);
      if (matchSym(nextSyms)) {
        return toCommitPoint(cur);
      }
    }
    return toCommitPoint(fileCommits[0]!);
  }

  async function findBlockLastSubstantivePoint(
    docFile: string,
    block: DocBlock,
  ): Promise<DocTimelinePoint | null> {
    if (!gitSession.isGitRepo) return null;
    const docCommits = await gitSession.getFileCommits(docFile);
    if (docCommits.length === 0) {
      return toWorktreePoint(gitSession);
    }

    const headDoc = await getParsedDocAtCommit(docCommits[0]!.sha, docFile);
    const hasNormalized = (parsed: ParsedDocFile | null): boolean =>
      Boolean(parsed?.blocks.some((b) => b.normalizedText === block.normalizedText));

    let startIdx = 0;
    if (!hasNormalized(headDoc)) {
      if (!docFileOverrides?.has(docFile)) {
        return toWorktreePoint(gitSession);
      }
      let foundIdx = -1;
      for (let i = 1; i < docCommits.length; i++) {
        const d = await getParsedDocAtCommit(docCommits[i]!.sha, docFile);
        if (hasNormalized(d)) {
          foundIdx = i;
          break;
        }
      }
      if (foundIdx === -1) {
        return toCommitPoint(docCommits[docCommits.length - 1]!);
      }
      startIdx = foundIdx;
    }

    for (let i = startIdx; i < docCommits.length; i++) {
      const cur = docCommits[i]!;
      const next = docCommits[i + 1];
      if (!next) return toCommitPoint(cur);
      const nextDoc = await getParsedDocAtCommit(next.sha, docFile);
      if (!hasNormalized(nextDoc)) {
        return toCommitPoint(cur);
      }
    }

    return toCommitPoint(docCommits[docCommits.length - 1]!);
  }

  async function findSymbolLastRuntimeChangePoint(
    sym: RepoSymbol,
  ): Promise<DocTimelinePoint | null> {
    if (!gitSession.isGitRepo) return null;
    const fileCommits = await gitSession.getFileCommits(sym.file);
    if (fileCommits.length === 0) {
      return toWorktreePoint(gitSession);
    }

    const matchSym = (list: RepoSymbol[]): RepoSymbol | undefined =>
      sym.qualifiedName
        ? list.find((s) => s.qualifiedName === sym.qualifiedName) ??
          list.find((s) => s.name === sym.name)
        : list.find((s) => s.name === sym.name);

    const headSyms = await getFileSymbolsAtCommit(fileCommits[0]!.sha, sym.file);
    const symAtHead = matchSym(headSyms);
    if (!symAtHead || symAtHead.runtimeFingerprint !== sym.runtimeFingerprint) {
      return toWorktreePoint(gitSession);
    }

    for (let i = 0; i < fileCommits.length; i++) {
      const cur = fileCommits[i]!;
      const next = fileCommits[i + 1];
      if (!next) return toCommitPoint(cur);
      const nextSyms = await getFileSymbolsAtCommit(next.sha, sym.file);
      const symAtNext = matchSym(nextSyms);
      if (!symAtNext || symAtNext.runtimeFingerprint !== sym.runtimeFingerprint) {
        return toCommitPoint(cur);
      }
    }

    return toCommitPoint(fileCommits[fileCommits.length - 1]!);
  }

  return {
    getParsedDocAtCommit,
    getFileSymbolsAtCommit,
    getPackageManifestAtCommit,
    getPackageScriptsAtCommit,
    getSymbolIndexAtCommit,
    findScriptLastChangePoint,
    findFileLatestPoint,
    findSymbolRemovalPoint,
    findBlockLastSubstantivePoint,
    findSymbolLastRuntimeChangePoint,
  };
}
