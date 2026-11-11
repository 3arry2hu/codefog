import * as fs from "node:fs/promises";
import * as path from "node:path";
import ts from "typescript";
import { collectFilesUnderDir, isInstructionFile } from "./doc-markdown.js";
import { extractRuntimeFunctionFingerprints } from "./git-freshness.js";
import {
  getPolyglotAdapter,
  isPolyglotSourceFile,
  isPolyglotTestFile,
} from "./polyglot.js";
import { computeRiskScore, createDeterministicFindingId } from "./scoring.js";
import type { DocClaim, DocReferent, EvidenceState, Finding } from "./types.js";

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

const KNOWN_PATH_EXTENSIONS =
  /\.(?:md|mdc|ts|tsx|js|jsx|mjs|cjs|json|html|htm|css|svg|xml|yaml|yml|toml|go|mod|sum|rs|java|py|sh|txt|lcov|info|out|cov|profdata|lock)$/i;

const KNOWN_TOP_DIRS = new Set([
  "src",
  "docs",
  "tests",
  "test",
  "lib",
  "bin",
  "dist",
  "build",
  "target",
  "coverage",
  "scripts",
  "skills",
  "oracles",
  "internal",
  "pkg",
  "cmd",
  "crates",
  "services",
  "reports",
  "config",
  "packages",
  "apps",
  "tools",
  "adr",
]);

export function looksLikePathToken(token: string): boolean {
  if (!token || /\s/.test(token)) return false;
  if (token.startsWith("-")) return false;
  if (/^(?:https?:|mailto:|tel:|git\+|data:)/i.test(token)) return false;
  // Scoped npm package like @barryzhu/codefog or @types/node
  if (/^@[a-z0-9-~][a-z0-9-._~]*\/[a-z0-9-._~]+(?:@[^\s]+)?$/i.test(token)) return false;
  if (/^(?:origin|HEAD|refs)\//.test(token)) return false;
  if (/[<>|"'`;(){}=$]/.test(token)) return false;

  const withoutAnchor = token.split("#")[0] ?? token;
  const withoutLine = withoutAnchor.replace(/:\d+(?:-\d+)?$/, "");
  if (!withoutLine) return false;

  // Version strings like v1.4.0 or 1.0.0
  if (/^v?\d+(?:\.\d+)+$/i.test(withoutLine)) return false;

  if (
    withoutLine === ".gitignore" ||
    withoutLine === "Dockerfile" ||
    withoutLine === "Makefile" ||
    KNOWN_PATH_EXTENSIONS.test(withoutLine)
  ) {
    return true;
  }

  if (withoutLine.includes("/")) {
    if (
      withoutLine.startsWith("./") ||
      withoutLine.startsWith("../") ||
      withoutLine.startsWith(".") ||
      withoutLine.startsWith("/") ||
      withoutLine.endsWith("/") ||
      withoutLine.includes("*")
    ) {
      return true;
    }
    const firstSeg = withoutLine.split("/")[0] ?? "";
    if (KNOWN_TOP_DIRS.has(firstSeg)) {
      return true;
    }
  }

  return false;
}

export interface RepoSymbol {
  name: string;
  qualifiedName?: string;
  kind: "function" | "class" | "method";
  file: string;
  startLine: number;
  endLine: number;
  runtimeFingerprint: string;
}

export interface RepoSymbolIndex {
  byName: Map<string, RepoSymbol[]>;
  byQualifiedName: Map<string, RepoSymbol[]>;
  byFile: Map<string, RepoSymbol[]>;
}

const NON_SYMBOL_LITERALS = new Set([
  "true",
  "false",
  "null",
  "undefined",
  "NaN",
  "Infinity",
  "void",
  "this",
  "super",
  "self",
  "nil",
  "None",
  "Some",
  "Ok",
  "Err",
  "string",
  "number",
  "boolean",
  "any",
  "unknown",
  "never",
  "object",
  "bigint",
  "symbol",
]);

function isRepoTestFile(relPath: string): boolean {
  const norm = toPosix(relPath);
  return (
    /\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(norm) ||
    /(?:^|\/)tests?\//.test(norm) ||
    isPolyglotTestFile(norm)
  );
}

export function isRepoSourceFile(relPath: string): boolean {
  const norm = toPosix(relPath);
  if (isRepoTestFile(norm)) return false;
  if (norm.endsWith(".d.ts")) return false;
  return /\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(norm) || isPolyglotSourceFile(norm);
}

export function extractSymbolsFromSource(sourceText: string, filePath: string): RepoSymbol[] {
  const relPath = toPosix(filePath);
  const polyAdapter = getPolyglotAdapter(relPath);
  if (polyAdapter) {
    return polyAdapter.extractSymbols(sourceText, relPath);
  }

  const symbols: RepoSymbol[] = [];
  const sf = ts.createSourceFile(
    relPath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    relPath.endsWith(".tsx") || relPath.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const fnFingerprints = extractRuntimeFunctionFingerprints(sourceText, relPath);

  function visit(node: ts.Node, enclosingClass?: string): void {
    if (ts.isFunctionDeclaration(node) && node.name) {
      const name = node.name.text;
      const startLine = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      const endLine = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
      symbols.push({
        name,
        kind: "function",
        file: relPath,
        startLine,
        endLine,
        runtimeFingerprint: fnFingerprints.get(name) ?? `fn:${name}`,
      });
    } else if (ts.isClassDeclaration(node) && node.name) {
      const className = node.name.text;
      const startLine = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      const endLine = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
      const memberFps: string[] = [];
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) && member.name) {
          const mName = member.name.getText(sf);
          memberFps.push(`${mName}:${fnFingerprints.get(mName) ?? ""}`);
        } else if (ts.isPropertyDeclaration(member) && member.name) {
          const pName = member.name.getText(sf);
          const initText = member.initializer
            ? member.initializer.getText(sf).replace(/\s+/g, "")
            : "";
          memberFps.push(`prop:${pName}=${initText}`);
        } else if (ts.isConstructorDeclaration(member) && member.body) {
          memberFps.push(`ctor:${member.body.getText(sf).replace(/\s+/g, "")}`);
        }
      }
      symbols.push({
        name: className,
        kind: "class",
        file: relPath,
        startLine,
        endLine,
        runtimeFingerprint: `class:${className}{${memberFps.join(";")}}`,
      });
      ts.forEachChild(node, (child) => visit(child, className));
      return;
    } else if (ts.isMethodDeclaration(node) && node.name) {
      const name = node.name.getText(sf);
      const startLine = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      const endLine = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
      symbols.push({
        name,
        ...(enclosingClass ? { qualifiedName: `${enclosingClass}.${name}` } : {}),
        kind: "method",
        file: relPath,
        startLine,
        endLine,
        runtimeFingerprint: fnFingerprints.get(name) ?? `method:${name}`,
      });
      return;
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      const name = node.name.text;
      const startLine = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      const endLine = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
      symbols.push({
        name,
        kind: "function",
        file: relPath,
        startLine,
        endLine,
        runtimeFingerprint: fnFingerprints.get(name) ?? `fn:${name}`,
      });
      return;
    }
    ts.forEachChild(node, (child) => visit(child, enclosingClass));
  }

  visit(sf);
  return symbols.sort((a, b) => a.startLine - b.startLine);
}

export function addSymbolToIndex(
  sym: RepoSymbol,
  byName: Map<string, RepoSymbol[]>,
  byQualifiedName: Map<string, RepoSymbol[]>,
): void {
  const list = byName.get(sym.name) ?? [];
  list.push(sym);
  byName.set(sym.name, list);
  if (sym.qualifiedName) {
    const qKeys = new Set([sym.qualifiedName, sym.qualifiedName.replace(/::|#/g, ".")]);
    for (const qk of qKeys) {
      const qList = byQualifiedName.get(qk) ?? [];
      qList.push(sym);
      byQualifiedName.set(qk, qList);
    }
  }
}

export async function buildRepoSymbolIndex(rootDir: string): Promise<RepoSymbolIndex> {
  const sourceFiles = new Set<string>();
  await collectFilesUnderDir(
    rootDir,
    rootDir,
    (rel) => isRepoSourceFile(rel),
    sourceFiles,
  );

  const byName = new Map<string, RepoSymbol[]>();
  const byQualifiedName = new Map<string, RepoSymbol[]>();
  const byFile = new Map<string, RepoSymbol[]>;

  const sortedFiles = Array.from(sourceFiles).sort((a, b) => a.localeCompare(b));
  for (const relPath of sortedFiles) {
    let sourceText = "";
    try {
      sourceText = await fs.readFile(path.join(rootDir, relPath), "utf8");
    } catch {
      continue;
    }
    const fileSymbols = extractSymbolsFromSource(sourceText, relPath);
    byFile.set(relPath, fileSymbols);
    for (const sym of fileSymbols) {
      addSymbolToIndex(sym, byName, byQualifiedName);
    }
  }

  return { byName, byQualifiedName, byFile };
}

export function parseCandidateSymbolToken(code: string): {
  bareName?: string;
  qualifiedName?: string;
} | null {
  const trimmed = code.trim();
  if (!trimmed || trimmed.startsWith("-")) return null;
  const withoutCall = trimmed.replace(/\s*\([^()]*\)$/, "").trim();
  if (!withoutCall || NON_SYMBOL_LITERALS.has(withoutCall)) return null;

  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(withoutCall)) {
    return { bareName: withoutCall };
  }

  const normalized = withoutCall.replace(/::|#/g, ".");
  if (/^[A-Za-z_$][A-Za-z0-9_$]*\.[A-Za-z_$][A-Za-z0-9_$]*$/.test(normalized)) {
    const parts = normalized.split(".");
    return {
      qualifiedName: withoutCall,
      bareName: parts[parts.length - 1],
    };
  }

  return null;
}

export function resolveSymbolInIndex(
  candidate: { bareName?: string; qualifiedName?: string },
  symbolIndex: RepoSymbolIndex,
): RepoSymbol[] {
  if (candidate.qualifiedName) {
    const byQual =
      symbolIndex.byQualifiedName.get(candidate.qualifiedName) ??
      symbolIndex.byQualifiedName.get(candidate.qualifiedName.replace(/::|#/g, "."));
    if (byQual && byQual.length > 0) return byQual;
  }
  if (candidate.bareName) {
    return symbolIndex.byName.get(candidate.bareName) ?? [];
  }
  return [];
}

const KNOWN_GENERATED_DIRS = new Set([
  ".codefog",
  "coverage",
  "target",
  "dist",
  "build",
  "node_modules",
]);

function globPatternToRegex(pattern: string): RegExp {
  let pat = pattern.trim();
  const anchored = pat.startsWith("/");
  if (anchored) pat = pat.slice(1);
  const dirOnly = pat.endsWith("/");
  if (dirOnly) pat = pat.slice(0, -1);

  const escaped = pat
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, ".*");

  if (dirOnly) {
    return anchored
      ? new RegExp(`^${escaped}(?:/.*)?$`)
      : new RegExp(`(?:^|/)${escaped}(?:/.*)?$`);
  }
  if (anchored || pat.includes("/")) {
    return new RegExp(`^${escaped}(?:/.*)?$`);
  }
  return new RegExp(`(?:^|/)${escaped}(?:/.*)?$`);
}

export async function loadGitignoreMatchers(rootDir: string): Promise<RegExp[]> {
  try {
    const raw = await fs.readFile(path.join(rootDir, ".gitignore"), "utf8");
    const matchers: RegExp[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) continue;
      matchers.push(globPatternToRegex(trimmed));
    }
    return matchers;
  } catch {
    return [];
  }
}

export function isGeneratedArtifactPath(
  rawPath: string,
  gitignoreMatchers: RegExp[],
): boolean {
  const clean = toPosix(rawPath)
    .replace(/^\.\//, "")
    .replace(/^\//, "")
    .replace(/\/+$/, "");
  if (!clean) return false;
  const parts = clean.split("/");
  if (parts.some((p) => KNOWN_GENERATED_DIRS.has(p))) {
    return true;
  }
  return gitignoreMatchers.some((re) => re.test(clean));
}

export interface PackageManifestInfo {
  hasPackageJson: boolean;
  packageName?: string;
  scripts: Map<string, string>;
  binNames: Set<string>;
  binFiles: string[];
  binSubcommands: Set<string>;
}

export function inferCommandIntent(
  rawCmd: string,
): "install" | "build" | "test" | "lint" | undefined {
  const cmd = rawCmd.trim().replace(/^\$\s+/, "");
  if (!cmd || looksLikePathToken(cmd)) return undefined;
  if (
    /^(?:npm|pnpm|yarn|bun)\s+(?:install|i|ci)(?:\s|$)/.test(cmd) ||
    /^(?:go\s+mod\s+(?:download|tidy)|cargo\s+fetch|(?:mvn|\.\/mvnw)\s+(?:clean\s+)?install)(?:\s|$)/.test(
      cmd,
    )
  ) {
    return "install";
  }
  if (
    /^(?:npm|pnpm|yarn|bun)\s+(?:test|t|tst|run\s+test(?::\S+)?)(?:\s|$)/.test(cmd) ||
    /^(?:npx\s+|pnpm\s+(?:exec\s+|dlx\s+)?|yarn\s+|bunx\s+)?(?:vitest|jest|mocha|pytest)(?:\s|$)/.test(
      cmd,
    ) ||
    /^node\s+--test(?:\s|$)/.test(cmd) ||
    /^(?:go\s+test|cargo\s+(?:test|nextest)|(?:mvn|\.\/mvnw)\s+test|(?:\.\/gradlew|gradle)\s+test)(?:\s|$)/.test(
      cmd,
    )
  ) {
    return "test";
  }
  if (
    /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?lint(?::\S+)?(?:\s|$)/.test(cmd) ||
    /^(?:npx\s+|pnpm\s+(?:exec\s+|dlx\s+)?|yarn\s+|bunx\s+)?(?:eslint|biome\s+(?:check|lint)|oxlint|golangci-lint)(?:\s|$)/.test(
      cmd,
    ) ||
    /^(?:cargo\s+clippy|go\s+vet)(?:\s|$)/.test(cmd)
  ) {
    return "lint";
  }
  if (
    /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build(?::\S+)?(?:\s|$)/.test(cmd) ||
    /^(?:npx\s+|pnpm\s+(?:exec\s+|dlx\s+)?|yarn\s+|bunx\s+)?(?:tsc|tsup|vite\s+build|rollup|webpack|esbuild)(?:\s|$)/.test(
      cmd,
    ) ||
    /^(?:go\s+build|cargo\s+build|(?:mvn|\.\/mvnw)\s+(?:clean\s+)?(?:package|compile)|(?:\.\/gradlew|gradle)\s+build)(?:\s|$)/.test(
      cmd,
    )
  ) {
    return "build";
  }
  return undefined;
}

export function extractSubcommandsFromCliSource(
  sourceText: string,
  binNames: Set<string>,
): Set<string> {
  const subcommands = new Set<string>();

  // Match comparisons like argv[0] === "verify", cmd === "sync", arg === "install-skill"
  const eqRe =
    /\b(?:argv\[\d+\]|arg|cmd|subcommand|command)\s*===\s*["']([a-z][a-z0-9-]*)["']/g;
  let m: RegExpExecArray | null;
  while ((m = eqRe.exec(sourceText)) !== null) {
    if (m[1]) subcommands.add(m[1]);
  }

  // Match switch cases like case "verify":
  const caseRe = /\bcase\s+["']([a-z][a-z0-9-]*)["']\s*:/g;
  while ((m = caseRe.exec(sourceText)) !== null) {
    if (m[1]) subcommands.add(m[1]);
  }

  // Match .command("verify")
  const dotCmdRe = /\.command\(\s*["']([a-z][a-z0-9-]*)/g;
  while ((m = dotCmdRe.exec(sourceText)) !== null) {
    if (m[1]) subcommands.add(m[1]);
  }

  // Match usage lines `<bin> <subcmd>`
  for (const bin of binNames) {
    if (bin.includes("/")) continue;
    const escapedBin = bin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const usageRe = new RegExp(`\\b${escapedBin}\\s+([a-z][a-z0-9-]*)\\b`, "g");
    while ((m = usageRe.exec(sourceText)) !== null) {
      if (m[1]) subcommands.add(m[1]);
    }
  }

  return subcommands;
}

export async function loadPackageManifestInfo(rootDir: string): Promise<PackageManifestInfo> {
  const scripts = new Map<string, string>();
  const binNames = new Set<string>();
  const binFiles: string[] = [];
  const binSubcommands = new Set<string>();

  let raw = "";
  try {
    raw = await fs.readFile(path.join(rootDir, "package.json"), "utf8");
  } catch {
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
  };
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
    try {
      const cliSrc = await fs.readFile(path.join(rootDir, rel), "utf8");
      for (const sub of extractSubcommandsFromCliSource(cliSrc, binNames)) {
        binSubcommands.add(sub);
      }
    } catch {
      // ignore missing file
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
}

export async function pathExists(absPath: string): Promise<boolean> {
  try {
    await fs.access(absPath);
    return true;
  } catch {
    return false;
  }
}

export async function resolveInlineCommandClaim(
  code: string,
  rootDir: string,
  pkgInfo: PackageManifestInfo,
  isInstruction = false,
): Promise<{
  referentText: string;
  state: EvidenceState;
  referent?: DocReferent;
  commandIntent?: "install" | "build" | "test" | "lint";
} | null> {
  const trimmed = code.trim().replace(/^\$\s+/, "");
  if (!trimmed || trimmed.startsWith("-")) return null;

  // Reject multi-command pipelines or prose with sentence punctuation
  const firstSegment = trimmed.split(/\s*(?:&&|\|\||;)\s*/)[0] ?? trimmed;
  const commandIntent = inferCommandIntent(firstSegment);

  // 1. <pm> run <script> [args...]
  const pmRunMatch =
    /^(?:npm|pnpm|yarn|bun)\s+run(?:-script)?\s+([A-Za-z0-9_:.-]+)(?:\s+.*)?$/.exec(
      firstSegment,
    );
  if (pmRunMatch && pmRunMatch[1]) {
    const scriptName = pmRunMatch[1];
    const def = pkgInfo.scripts.get(scriptName);
    const exists = def !== undefined;
    const referent: DocReferent | undefined = exists
      ? {
          kind: "script",
          file: "package.json",
          script: scriptName,
          scriptDefinition: def,
        }
      : undefined;
    return {
      referentText: trimmed,
      state: exists ? "weak-evidence" : "fog-returned",
      ...(referent ? { referent } : {}),
      ...(commandIntent ? { commandIntent } : {}),
    };
  }

  // 2. <pm> test / t / tst / start / stop / restart
  const pmAliasMatch =
    /^(?:npm|pnpm|yarn|bun)\s+(test|t|tst|start|stop|restart)(?:\s+.*)?$/.exec(firstSegment);
  if (pmAliasMatch && pmAliasMatch[1]) {
    const rawAlias = pmAliasMatch[1];
    const scriptName = rawAlias === "t" || rawAlias === "tst" ? "test" : rawAlias;
    const def = pkgInfo.scripts.get(scriptName);
    const exists = def !== undefined || (!pkgInfo.hasPackageJson && isInstruction);
    const referent: DocReferent | undefined =
      def !== undefined
        ? {
            kind: "script",
            file: "package.json",
            script: scriptName,
            scriptDefinition: def,
          }
        : undefined;
    return {
      referentText: trimmed,
      state: exists ? "weak-evidence" : "fog-returned",
      ...(referent ? { referent } : {}),
      ...(commandIntent ? { commandIntent } : {}),
    };
  }

  // 3. node / tsx / ts-node <file>
  const nodeFileMatch =
    /^(?:npx\s+)?(?:node|tsx|ts-node)\s+(?:-[A-Za-z0-9-=]+\s+)*([^\s-][^\s]*)(?:\s+.*)?$/.exec(
      firstSegment,
    );
  if (nodeFileMatch && nodeFileMatch[1]) {
    const fileArg = nodeFileMatch[1].replace(/^\.\//, "");
    if (
      !fileArg.startsWith("<") &&
      !fileArg.startsWith("[") &&
      (fileArg.includes("/") || /\.(?:js|mjs|cjs|ts|tsx|jsx)$/i.test(fileArg))
    ) {
      const exists = await pathExists(path.join(rootDir, fileArg));
      const referent: DocReferent | undefined = exists
        ? { kind: "file", file: fileArg }
        : undefined;
      return {
        referentText: trimmed,
        state: exists ? "weak-evidence" : "fog-returned",
        ...(referent ? { referent } : {}),
        ...(commandIntent ? { commandIntent } : {}),
      };
    }
  }

  // 4. Repository `bin` subcommand
  if (pkgInfo.binNames.size > 0) {
    const tokens = firstSegment.split(/\s+/);
    let idx = 0;
    if (tokens[0] === "npx") {
      idx = 1;
      if (tokens[idx] === "--yes" || tokens[idx] === "-y") idx++;
    }
    const rawBinToken = tokens[idx] ?? "";
    const binToken = rawBinToken.replace(/@[^\s/]+$/, "");
    if (binToken && pkgInfo.binNames.has(binToken)) {
      const nextToken = tokens[idx + 1];
      if (!nextToken || nextToken.startsWith("-") || nextToken.startsWith("[") || nextToken.startsWith("<") || nextToken === ".") {
        const referent: DocReferent = {
          kind: "bin",
          file: pkgInfo.binFiles[0] ?? "package.json",
          bin: binToken,
        };
        return {
          referentText: trimmed,
          state: "weak-evidence",
          referent,
          ...(commandIntent ? { commandIntent } : {}),
        };
      }
      if (/^[a-z][a-z0-9-]*$/.test(nextToken) && !looksLikePathToken(nextToken)) {
        const validSub = pkgInfo.binSubcommands.has(nextToken);
        const referent: DocReferent | undefined = validSub
          ? {
              kind: "bin",
              file: pkgInfo.binFiles[0] ?? "package.json",
              bin: binToken,
              subcommand: nextToken,
            }
          : undefined;
        return {
          referentText: trimmed,
          state: validSub ? "weak-evidence" : "fog-returned",
          ...(referent ? { referent } : {}),
          ...(commandIntent ? { commandIntent } : {}),
        };
      }
    }
  }

  // 5. In AI instruction files, commands matching the fixed intent table (including third-party tools like vitest, tsc, go test, cargo, mvn) participate in intent comparison without existence failure
  if (isInstruction && commandIntent) {
    return {
      referentText: trimmed,
      state: "weak-evidence",
      commandIntent,
    };
  }

  return null;
}

export async function checkExternalUrlReachable(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
    });
    if (res.ok || (res.status >= 200 && res.status < 400)) {
      return true;
    }
    const getRes = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
    });
    return getRes.ok || (getRes.status >= 200 && getRes.status < 400);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function detectInstructionConflictFindings(docClaims: DocClaim[]): Finding[] {
  const findings: Finding[] = [];
  const claimsByIntent = new Map<
    NonNullable<DocClaim["commandIntent"]>,
    DocClaim[]
  >();
  for (const claim of docClaims) {
    if (
      claim.kind === "command" &&
      claim.commandIntent &&
      isInstructionFile(claim.file)
    ) {
      const list = claimsByIntent.get(claim.commandIntent) ?? [];
      list.push(claim);
      claimsByIntent.set(claim.commandIntent, list);
    }
  }

  const normalizeCommandForConflict = (raw: string): string =>
    raw.trim().replace(/^\$\s+/, "").replace(/\s+/g, " ");

  for (const [intent, intentClaims] of claimsByIntent.entries()) {
    let hasCrossFileConflict = false;
    for (let i = 0; i < intentClaims.length && !hasCrossFileConflict; i++) {
      for (let j = i + 1; j < intentClaims.length; j++) {
        const a = intentClaims[i]!;
        const b = intentClaims[j]!;
        if (
          a.file !== b.file &&
          normalizeCommandForConflict(a.referentText) !==
            normalizeCommandForConflict(b.referentText)
        ) {
          hasCrossFileConflict = true;
          break;
        }
      }
    }

    if (!hasCrossFileConflict) continue;

    const sortedClaims = [...intentClaims].sort(
      (a, b) => a.file.localeCompare(b.file) || a.startLine - b.startLine,
    );

    for (const c of sortedClaims) {
      if (c.state !== "fog-returned") {
        c.state = "weak-evidence";
      }
    }

    const primary = sortedClaims[0]!;
    const locationsList = sortedClaims.map((c) => ({
      file: c.file,
      symbol: c.text,
      startLine: c.startLine,
      endLine: c.endLine,
      command: c.referentText,
    }));
    const conflictSummary = sortedClaims
      .map((c) => `${c.file}:${c.startLine} ('${c.referentText}')`)
      .join(" vs ");
    const locationRangeSummary = sortedClaims
      .map((c) => `${c.file}:${c.startLine}-${c.endLine}`)
      .join(", ");

    findings.push({
      id: createDeterministicFindingId(
        primary.file,
        `instruction-conflict:${intent}:${sortedClaims.map((c) => `${c.file}:${c.startLine}:${c.referentText}`).join("|")}`,
      ),
      title: `instruction-conflict (${intent}): ${conflictSummary}`,
      state: "weak-evidence",
      subjectType: "doc",
      tags: ["instruction-conflict"],
      riskScore: computeRiskScore({
        unverifiedLoc: sortedClaims.length,
        churn90d: 1,
        cyclomaticComplexity: 1,
        state: "weak-evidence",
      }),
      agentReady: true,
      location: {
        file: primary.file,
        symbol: primary.text,
        startLine: primary.startLine,
        endLine: primary.endLine,
      },
      locations: locationsList,
      reason: `Conflicting '${intent}' commands across AI instruction files (instruction-conflict): ${conflictSummary}.`,
      evidence: {
        executedByTests: 0,
        assertionsOnOutcome: 0,
        pseudoTested: false,
        oracleContest: false,
        oracleIds: [],
        missedBoundary: false,
        survivingMutants: [],
      },
      suggestedAction: `Align '${intent}' command across AI instruction files (${locationRangeSummary}) so all agents execute the same command.`,
      acceptanceCheck: {
        command: `npx codefog verify ${primary.file} --lines ${primary.blockStartLine}-${primary.blockEndLine}`,
        criteria: [
          `Instruction files (${sortedClaims.map((c) => `${c.file}:${c.startLine}`).join(", ")}) specify a consistent '${intent}' command`,
        ],
      },
    });
  }

  return findings;
}
