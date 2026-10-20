import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ts from "typescript";
import {
  extractPolyglotRuntimeFingerprints,
  extractRustInlineTestFingerprint,
  getPolyglotAdapter,
  isPolyglotSourceFile,
} from "./polyglot.js";

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
  lastCodeChangeAt?: string;
  lastTestChangeAt?: string;
  functions: Map<string, FunctionFreshnessInfo>;
}

/**
 * Extracts a canonical runtime AST fingerprint for each function/method in a TypeScript file.
 * Strips all comments, whitespace, type annotations, interfaces, and type aliases so that
 * pure formatting, comment, or type-only edits produce the exact same fingerprint.
 */
export function extractRuntimeFunctionFingerprints(
  sourceText: string,
  fileName = "file.ts",
): Map<string, string> {
  if (isPolyglotSourceFile(fileName)) {
    return extractPolyglotRuntimeFingerprints(sourceText, fileName);
  }
  const sf = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const fingerprints = new Map<string, string>();

  function serializeRuntimeNode(node: ts.Node): string {
    // Ignore purely type-level constructs
    if (
      ts.isTypeNode(node) ||
      ts.isTypeParameterDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node)
    ) {
      return "";
    }

    // For TypeAssertion / AsExpression / SatisfiesExpression, only serialize the inner runtime expression
    if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node)) {
      return serializeRuntimeNode(node.expression);
    }

    // For ParameterDeclaration, keep parameter name and initializer (runtime default), skip type annotation
    if (ts.isParameter(node)) {
      const nameStr = serializeRuntimeNode(node.name);
      const initStr = node.initializer ? `=${serializeRuntimeNode(node.initializer)}` : "";
      const dotDotDot = node.dotDotDotToken ? "..." : "";
      return `${dotDotDot}${nameStr}${initStr}`;
    }

    // For VariableDeclaration, keep name and initializer, skip type annotation
    if (ts.isVariableDeclaration(node)) {
      const nameStr = serializeRuntimeNode(node.name);
      const initStr = node.initializer ? `=${serializeRuntimeNode(node.initializer)}` : "";
      return `Var(${nameStr}${initStr})`;
    }

    if (ts.isIdentifier(node)) {
      return `id:${node.text}`;
    }
    if (
      ts.isNumericLiteral(node) ||
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isRegularExpressionLiteral(node)
    ) {
      return `lit:${node.text}`;
    }
    if (node.kind === ts.SyntaxKind.TrueKeyword) return "lit:true";
    if (node.kind === ts.SyntaxKind.FalseKeyword) return "lit:false";
    if (node.kind === ts.SyntaxKind.NullKeyword) return "lit:null";

    if (ts.isBinaryExpression(node)) {
      const op = ts.tokenToString(node.operatorToken.kind) ?? String(node.operatorToken.kind);
      return `Bin(${serializeRuntimeNode(node.left)},${op},${serializeRuntimeNode(node.right)})`;
    }
    if (ts.isPrefixUnaryExpression(node)) {
      const op = ts.tokenToString(node.operator) ?? String(node.operator);
      return `Pre(${op},${serializeRuntimeNode(node.operand)})`;
    }
    if (ts.isPostfixUnaryExpression(node)) {
      const op = ts.tokenToString(node.operator) ?? String(node.operator);
      return `Post(${serializeRuntimeNode(node.operand)},${op})`;
    }

    const childParts: string[] = [];
    ts.forEachChild(node, (child) => {
      // Skip modifier tokens (export, async, public, etc.) except async which affects runtime
      if (ts.canHaveModifiers(node)) {
        const modifiers = ts.getModifiers(node);
        if (modifiers && modifiers.includes(child as ts.Modifier)) {
          if (child.kind === ts.SyntaxKind.AsyncKeyword) {
            childParts.push("async");
          }
          return;
        }
      }
      const serialized = serializeRuntimeNode(child);
      if (serialized) {
        childParts.push(serialized);
      }
    });

    return `${ts.SyntaxKind[node.kind]}(${childParts.join(",")})`;
  }

  function recordFunction(
    name: string,
    params: ts.NodeArray<ts.ParameterDeclaration>,
    body: ts.Node | undefined,
  ): void {
    if (!body) return;
    const paramSig = params.map((p) => serializeRuntimeNode(p)).join(",");
    const bodySig = serializeRuntimeNode(body);
    fingerprints.set(name, `fn(${paramSig}){${bodySig}}`);
  }

  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name) {
      recordFunction(node.name.text, node.parameters, node.body);
      return;
    }
    if (ts.isMethodDeclaration(node) && node.name) {
      recordFunction(node.name.getText(sf), node.parameters, node.body);
      return;
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      recordFunction(node.name.text, node.initializer.parameters, node.initializer.body);
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return fingerprints;
}

interface CommitEntry {
  sha: string;
  isoDate: string;
}

async function runGit(rootDir: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: rootDir });
    return stdout.trim();
  } catch {
    return null;
  }
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
  const polyAdapter = getPolyglotAdapter(relPath);
  let inlineTestCommits: CommitEntry[] | null = null;
  if (polyAdapter?.extractInlineTestBlockFingerprints && srcHistory.length > 0) {
    const inlineCommits: CommitEntry[] = [];
    for (let i = srcHistory.length - 1; i >= 0; i--) {
      const c = srcHistory[i]!;
      const curText = await getSourceTextAtCommit(c.sha);
      const curTestFp = curText ? extractRustInlineTestFingerprint(curText) : "";
      if (!curTestFp) continue;
      if (i === srcHistory.length - 1) {
        inlineCommits.unshift(c);
      } else {
        const prevCommit = srcHistory[i + 1]!;
        const prevText = await getSourceTextAtCommit(prevCommit.sha);
        const prevTestFp = prevText ? extractRustInlineTestFingerprint(prevText) : "";
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
      Boolean(polyAdapter?.extractInlineTestBlockFingerprints) &&
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
    lastCodeChangeAt: latestSrc.isoDate,
    functions,
  };
}
