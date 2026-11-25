import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getLanguageAdapter, tsLanguageAdapter } from "./adapters/index.js";

const execFileAsync = promisify(execFile);

export interface FunctionFreshnessInfo {
  symbol: string;
  isFogReturned: boolean;
  isSelfProofFog: boolean;
  lastCodeChangeAt?: string;
  lastTestChangeAt?: string;
}

export interface FileGitFreshness {
  isGitRepo: boolean;
  churn90d: number;
  shortTermChurn14d?: number;
  lastCodeChangeAt?: string;
  lastTestChangeAt?: string;
  functions: Map<string, FunctionFreshnessInfo>;
}

/** Extracts a canonical fingerprint of every named function's runtime behavior. */
export function extractRuntimeFunctionFingerprints(
  sourceText: string,
  fileName = "file.ts",
): Map<string, string> {
  const adapter = getLanguageAdapter(fileName) ?? tsLanguageAdapter;
  return adapter.extractRuntimeFingerprints(sourceText, fileName);
}

export interface CommitEntry {
  sha: string;
  isoDate: string;
}

export interface RepoCommitInfo {
  sha: string;
  shortSha: string;
  isoDate: string;
  index: number;
}

export interface GitTimelineSession {
  isGitRepo: boolean;
  commits: RepoCommitInfo[];
  bySha: Map<string, RepoCommitInfo>;
  getFileCommits: (relPath: string) => Promise<RepoCommitInfo[]>;
  getFileTextAtCommit: (sha: string, relPath: string) => Promise<string | null>;
  listTrackedFilesAtCommit: (sha: string) => Promise<Set<string>>;
}

async function runGit(rootDir: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: rootDir,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function createGitTimelineSession(rootDir: string): Promise<GitTimelineSession> {
  const insideGit = await runGit(rootDir, ["rev-parse", "--is-inside-work-tree"]);
  if (insideGit !== "true") {
    return {
      isGitRepo: false,
      commits: [],
      bySha: new Map(),
      getFileCommits: async () => [],
      getFileTextAtCommit: async () => null,
      listTrackedFilesAtCommit: async () => new Set(),
    };
  }

  const logOut = await runGit(rootDir, ["log", "--format=%H|%h|%cI"]);
  const commits: RepoCommitInfo[] = [];
  const bySha = new Map<string, RepoCommitInfo>();
  if (logOut) {
    const lines = logOut.split(/\r?\n/).filter(Boolean);
    for (let idx = 0; idx < lines.length; idx++) {
      const [sha, shortSha, isoDate] = lines[idx]!.split("|");
      if (!sha) continue;
      const info: RepoCommitInfo = {
        sha,
        shortSha: shortSha || sha.slice(0, 7),
        isoDate: isoDate || "",
        index: idx,
      };
      commits.push(info);
      bySha.set(sha, info);
    }
  }

  const fileCommitsCache = new Map<string, Promise<RepoCommitInfo[]>>();
  const fileTextCache = new Map<string, Promise<string | null>>();
  const trackedFilesCache = new Map<string, Promise<Set<string>>>();

  return {
    isGitRepo: commits.length > 0,
    commits,
    bySha,
    getFileCommits: (relPath: string) => {
      const norm = relPath.replace(/\\/g, "/");
      let p = fileCommitsCache.get(norm);
      if (!p) {
        p = (async () => {
          const out = await runGit(rootDir, ["log", "--format=%H|%h|%cI", "--", norm]);
          if (!out) return [];
          const list: RepoCommitInfo[] = [];
          for (const line of out.split(/\r?\n/).filter(Boolean)) {
            const [sha, shortSha, isoDate] = line.split("|");
            if (!sha) continue;
            const existing = bySha.get(sha);
            if (existing) {
              list.push(existing);
            } else {
              list.push({
                sha,
                shortSha: shortSha || sha.slice(0, 7),
                isoDate: isoDate || "",
                index: commits.length,
              });
            }
          }
          return list;
        })();
        fileCommitsCache.set(norm, p);
      }
      return p;
    },
    getFileTextAtCommit: (sha: string, relPath: string) => {
      const norm = relPath.replace(/\\/g, "/");
      const key = `${sha}:${norm}`;
      let p = fileTextCache.get(key);
      if (!p) {
        p = (async () => {
          const t1 = await runGit(rootDir, ["show", `${sha}:./${norm}`]);
          if (t1 !== null) return t1;
          return runGit(rootDir, ["show", `${sha}:${norm}`]);
        })();
        fileTextCache.set(key, p);
      }
      return p;
    },
    listTrackedFilesAtCommit: (sha: string) => {
      let p = trackedFilesCache.get(sha);
      if (!p) {
        p = (async () => {
          const out = await runGit(rootDir, ["ls-tree", "-r", "--name-only", sha]);
          if (!out) return new Set<string>();
          return new Set(
            out
              .split(/\r?\n/)
              .map((s) => s.trim().replace(/\\/g, "/"))
              .filter(Boolean),
          );
        })();
        trackedFilesCache.set(sha, p);
      }
      return p;
    },
  };
}

async function getCommitHistory(rootDir: string, paths: string[]): Promise<CommitEntry[]> {
  if (paths.length === 0) return [];
  const out = await runGit(rootDir, ["log", "--format=%H|%cI", "--", ...paths]);
  if (!out) return [];
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [sha, isoDate] = line.split("|");
      return { sha: sha!, isoDate: isoDate! };
    });
}

async function getBlameShasForRange(
  rootDir: string,
  relPath: string,
  startLine: number,
  endLine: number,
): Promise<Set<string>> {
  const out = await runGit(rootDir, [
    "blame",
    "--porcelain",
    "-L",
    `${startLine},${endLine}`,
    "--",
    relPath,
  ]);
  const shas = new Set<string>();
  if (!out) return shas;
  for (const line of out.split(/\r?\n/)) {
    const match = /^([0-9a-f]{40})\s+\d+\s+\d+/.exec(line);
    if (match && match[1] && !/^0+$/.test(match[1])) {
      shas.add(match[1]);
    }
  }
  return shas;
}

export async function analyzeFileGitFreshness(params: {
  rootDir: string;
  relPath: string;
  currentSourceText: string;
  functionSpans: Array<{ name: string; startLine: number; endLine: number }>;
  associatedTestFiles: Map<string, string[]>;
  reportGeneratedAtMs?: number;
}): Promise<FileGitFreshness> {
  const {
    rootDir,
    relPath,
    currentSourceText,
    functionSpans,
    associatedTestFiles,
    reportGeneratedAtMs,
  } = params;
  const insideGit = await runGit(rootDir, ["rev-parse", "--is-inside-work-tree"]);
  if (insideGit !== "true") {
    return {
      isGitRepo: false,
      churn90d: 1,
      functions: new Map(),
    };
  }

  const srcHistory = await getCommitHistory(rootDir, [relPath]);
  if (srcHistory.length === 0) {
    return {
      isGitRepo: true,
      churn90d: 1,
      shortTermChurn14d: 0,
      functions: new Map(),
    };
  }

  const churnOut = await runGit(rootDir, [
    "log",
    "--since=90 days ago",
    "--oneline",
    "--",
    relPath,
  ]);
  const churn90d = Math.max(
    1,
    churnOut ? churnOut.split(/\r?\n/).filter(Boolean).length : 1,
  );
  const cutoff14d = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const shortTermChurn14d = srcHistory.filter((commit) => Date.parse(commit.isoDate) >= cutoff14d).length;

  const latestSrc = srcHistory[0]!;
  const oldestSrc = srcHistory[srcHistory.length - 1]!;
  const currentFingerprints = extractRuntimeFunctionFingerprints(currentSourceText, relPath);
  const baselineFingerprintCache = new Map<string, Map<string, string>>();
  const sourceTextAtCommitCache = new Map<string, string | null>();

  async function getSourceTextAtCommit(sha: string): Promise<string | null> {
    if (sourceTextAtCommitCache.has(sha)) {
      return sourceTextAtCommitCache.get(sha)!;
    }
    const text =
      (await runGit(rootDir, ["show", `${sha}:./${relPath}`])) ??
      (await runGit(rootDir, ["show", `${sha}:${relPath}`]));
    sourceTextAtCommitCache.set(sha, text);
    return text;
  }

  async function getFingerprintsAtCommit(sha: string): Promise<Map<string, string>> {
    if (baselineFingerprintCache.has(sha)) {
      return baselineFingerprintCache.get(sha)!;
    }
    const historicalText = await getSourceTextAtCommit(sha);
    const fp = historicalText
      ? extractRuntimeFunctionFingerprints(historicalText, relPath)
      : new Map<string, string>();
    baselineFingerprintCache.set(sha, fp);
    return fp;
  }

  // If the file's LanguageAdapter supports same-file inline test blocks (e.g. Rust `#[cfg(test)]`), find the commits where the inline test blocks changed
  const adapter = getLanguageAdapter(relPath);
  let inlineTestCommits: CommitEntry[] | null = null;
  if (adapter?.extractInlineTestBlockFingerprints && srcHistory.length > 0) {
    const serializeInlineTestMap = (text: string | null): string => {
      if (!text || !adapter.extractInlineTestBlockFingerprints) return "";
      const fpMap = adapter.extractInlineTestBlockFingerprints(text);
      if (fpMap.size === 0) return "";
      return Array.from(fpMap.entries())
        .map(([k, v]) => `${k}=${v}`)
        .join("||");
    };
    const inlineCommits: CommitEntry[] = [];
    for (let i = srcHistory.length - 1; i >= 0; i--) {
      const c = srcHistory[i]!;
      const curText = await getSourceTextAtCommit(c.sha);
      const curTestFp = serializeInlineTestMap(curText);
      if (!curTestFp) continue;
      if (i === srcHistory.length - 1) {
        inlineCommits.unshift(c);
      } else {
        const prevCommit = srcHistory[i + 1]!;
        const prevText = await getSourceTextAtCommit(prevCommit.sha);
        const prevTestFp = serializeInlineTestMap(prevText);
        if (curTestFp !== prevTestFp) {
          inlineCommits.unshift(c);
        }
      }
    }
    if (inlineCommits.length > 0) {
      inlineTestCommits = inlineCommits;
    }
  }

  const functions = new Map<string, FunctionFreshnessInfo>();
  const testHistoryCache = new Map<string, CommitEntry[]>();

  for (const span of functionSpans) {
    const fnName = span.name;
    const testFiles = associatedTestFiles.get(fnName) ?? [];
    const usesSameFileInlineTests =
      Boolean(adapter?.extractInlineTestBlockFingerprints) &&
      testFiles.length === 1 &&
      testFiles[0] === relPath &&
      inlineTestCommits !== null;

    let testHistory: CommitEntry[];
    if (usesSameFileInlineTests) {
      testHistory = inlineTestCommits!;
    } else {
      const cacheKey = testFiles.slice().sort().join("|");
      const cached = testHistoryCache.get(cacheKey);
      if (cached) {
        testHistory = cached;
      } else {
        testHistory = await getCommitHistory(rootDir, testFiles);
        testHistoryCache.set(cacheKey, testHistory);
      }
    }
    const latestTest = testHistory[0];

    let isFogReturned = false;
    let isSelfProofFog = false;

    if (latestTest) {
      // Check Self-proof Fog via git blame + commit history:
      // All blamed lines of the function (or initial file commit) share the exact same commit as the sole test commit
      if (testHistory.length === 1) {
        if (latestTest.sha === oldestSrc.sha) {
          isSelfProofFog = true;
        } else {
          const blameShas = await getBlameShasForRange(
            rootDir,
            relPath,
            span.startLine,
            span.endLine,
          );
          if (
            blameShas.size > 0 &&
            Array.from(blameShas).every((sha) => sha === latestTest.sha)
          ) {
            isSelfProofFog = true;
          }
        }
      }

      // Check Fog Returned:
      // Did the source file have commits after latestTest.sha (or after LCOV report mtime) that changed this function's runtime AST?
      const testCommitIdxInSrc = srcHistory.findIndex((c) => c.sha === latestTest.sha);
      const latestSrcMs = new Date(latestSrc.isoDate).getTime();
      const latestTestMs = new Date(latestTest.isoDate).getTime();
      const newerThanReport =
        reportGeneratedAtMs !== undefined && latestSrcMs > reportGeneratedAtMs + 1000;

      const srcModifiedAfterTest =
        (latestSrc.sha !== latestTest.sha &&
          (testCommitIdxInSrc > 0 || latestSrcMs >= latestTestMs)) ||
        newerThanReport;

      if (srcModifiedAfterTest) {
        const baselineFp = await getFingerprintsAtCommit(latestTest.sha);
        const beforeSig = baselineFp.get(fnName);
        const nowSig = currentFingerprints.get(fnName);
        if (beforeSig !== undefined && nowSig !== undefined && beforeSig !== nowSig) {
          isFogReturned = true;
        }
      }
    }

    functions.set(fnName, {
      symbol: fnName,
      isFogReturned,
      isSelfProofFog,
      lastCodeChangeAt: latestSrc.isoDate,
      lastTestChangeAt: latestTest?.isoDate,
    });
  }

  return {
    isGitRepo: true,
    churn90d,
    shortTermChurn14d,
    lastCodeChangeAt: latestSrc.isoDate,
    functions,
  };
}

export async function listTrackedRepoFiles(rootDir: string): Promise<Set<string>> {
  const files = await runGit(rootDir, ["ls-files", "--cached", "-z", "--"]);
  return new Set(files?.split("\0").filter(Boolean) ?? []);
}

export async function readRecentCommitFiles(
  rootDir: string,
): Promise<{ shallow: boolean; commits: string[][] }> {
  const shallow = await runGit(rootDir, ["rev-parse", "--is-shallow-repository"]);
  if (shallow !== "false") return { shallow: shallow === "true", commits: [] };
  const log = await runGit(rootDir, [
    "log", "--since-as-filter=180 days ago", "-n", "500", "--format=%x00%x00%H",
    "--name-only", "--no-renames", "-z",
  ]);
  const commits = log
    ?.split(/\0\0[0-9a-f]{40,64}\0/)
    .slice(1)
    .map((entry) => [...new Set(entry.replace(/^\n/, "").split("\0").filter(Boolean))]) ?? [];
  return { shallow: false, commits };
}
