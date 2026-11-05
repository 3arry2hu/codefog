import * as fs from "node:fs/promises";
import * as path from "node:path";
import ts from "typescript";
import {
  createGitTimelineSession,
  extractRuntimeFunctionFingerprints,
  type GitTimelineSession,
  type RepoCommitInfo,
} from "./git-freshness.js";
import {
  getPolyglotAdapter,
  isPolyglotSourceFile,
  isPolyglotTestFile,
  stripCommentsAndMaskStrings,
} from "./polyglot.js";
import {
  computeRiskScore,
  computeTrustScore,
  createDeterministicFindingId,
  emptyLocByState,
} from "./scoring.js";
import { evaluateDocCodeBlockClaim } from "./doc-runners.js";
import type {
  DocBlockKind,
  DocClaim,
  DocClaimKind,
  DocReferent,
  EvidenceState,
  Finding,
  LocByState,
} from "./types.js";

export interface DocBlock {
  kind: DocBlockKind;
  startLine: number;
  endLine: number;
  rawText: string;
  normalizedText: string;
  ignored: boolean;
  language?: string;
  codeContent?: string;
  headingSlug?: string;
}

export interface ParsedDocFile {
  file: string;
  content: string;
  lines: string[];
  ignoredFile: boolean;
  headings: Array<{ text: string; slug: string; line: number }>;
  blocks: DocBlock[];
}

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

export function isInstructionFile(relPath: string): boolean {
  const norm = toPosix(relPath);
  const base = path.posix.basename(norm);
  if (base === "AGENTS.md" || base === "CLAUDE.md") return true;
  if (norm === ".github/copilot-instructions.md") return true;
  if (norm.startsWith(".cursor/rules/")) return true;
  if (/^(?:.*\/)?skills\/.*\/SKILL\.md$/.test(norm) || norm === "skills/SKILL.md") {
    return true;
  }
  return false;
}

export function slugifyMarkdownHeading(rawHeading: string): string {
  const cleaned = rawHeading
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_~]/g, "")
    .trim()
    .toLowerCase();
  return cleaned
    .replace(/[^\p{L}\p{N}\s\-_]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

async function collectFilesUnderDir(
  dirAbs: string,
  rootDir: string,
  predicate: (relPath: string, entryName: string) => boolean,
  out: Set<string>,
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dirAbs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (
      entry.name === "node_modules" ||
      entry.name === ".git" ||
      entry.name === "vendor" ||
      entry.name === "dist" ||
      entry.name === "coverage" ||
      entry.name === ".codefog" ||
      entry.name === "target" ||
      entry.name === "build"
    ) {
      continue;
    }
    const full = path.join(dirAbs, entry.name);
    const rel = toPosix(path.relative(rootDir, full));
    if (entry.isDirectory()) {
      await collectFilesUnderDir(full, rootDir, predicate, out);
    } else if (entry.isFile() && predicate(rel, entry.name)) {
      out.add(rel);
    }
  }
}

export async function discoverDocFiles(rootDir: string): Promise<string[]> {
  const found = new Set<string>();

  // 1. Root-level .md files (includes README.md, GLOSSARY.md, AGENTS.md, CLAUDE.md, etc.)
  try {
    const rootEntries = await fs.readdir(rootDir, { withFileTypes: true });
    for (const entry of rootEntries) {
      if (
        entry.isFile() &&
        (entry.name.toLowerCase().endsWith(".md") ||
          entry.name === "AGENTS.md" ||
          entry.name === "CLAUDE.md")
      ) {
        found.add(entry.name);
      }
    }
  } catch {
    // ignore
  }

  // 2. docs/** and adr/**
  await collectFilesUnderDir(
    path.join(rootDir, "docs"),
    rootDir,
    (_rel, name) => name.toLowerCase().endsWith(".md"),
    found,
  );
  await collectFilesUnderDir(
    path.join(rootDir, "adr"),
    rootDir,
    (_rel, name) => name.toLowerCase().endsWith(".md"),
    found,
  );

  // 3. .cursor/rules/*
  await collectFilesUnderDir(
    path.join(rootDir, ".cursor", "rules"),
    rootDir,
    (_rel, name) => !name.startsWith("."),
    found,
  );

  // 4. .github/copilot-instructions.md
  try {
    const copilotPath = path.join(rootDir, ".github", "copilot-instructions.md");
    const st = await fs.stat(copilotPath);
    if (st.isFile()) {
      found.add(".github/copilot-instructions.md");
    }
  } catch {
    // optional
  }

  // 5. skills/**/SKILL.md
  await collectFilesUnderDir(
    path.join(rootDir, "skills"),
    rootDir,
    (_rel, name) => name === "SKILL.md" || name.toLowerCase().endsWith(".md"),
    found,
  );

  return Array.from(found).sort((a, b) => a.localeCompare(b));
}

function isTableSeparatorLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|") || !trimmed.includes("-")) return false;
  const cells = trimmed
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

function isTableLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length > 1;
}

function isHorizontalRule(line: string): boolean {
  return /^\s*(?:-\s*-\s*-[-\s]*|\*\s*\*\s*\*[\*\s]*|_\s*_\s*_[_\s]*)$/.test(line);
}

export function parseMarkdownDoc(file: string, content: string): ParsedDocFile {
  const lines = content.split(/\r?\n/);
  const blocks: DocBlock[] = [];
  const headings: Array<{ text: string; slug: string; line: number }> = [];
  const slugCounts = new Map<string, number>();

  let ignoredFile = false;
  let ignoreNextBlock = false;
  let ignoreCurrentTable = false;

  // First pass: check if <!-- codefog-ignore-file --> exists outside fenced code blocks
  let inFenceScan = false;
  let fenceMarkerScan = "";
  for (const line of lines) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]![0]!;
      if (!inFenceScan) {
        inFenceScan = true;
        fenceMarkerScan = marker;
      } else if (marker === fenceMarkerScan) {
        inFenceScan = false;
        fenceMarkerScan = "";
      }
      continue;
    }
    if (!inFenceScan) {
      const withoutInlineCode = line.replace(/`[^`]*`/g, "");
      if (/<!--\s*codefog-ignore-file\s*-->/i.test(withoutInlineCode)) {
        ignoredFile = true;
      }
    }
  }

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const lineNum = i + 1;
    const trimmed = line.trim();

    if (trimmed === "") {
      ignoreCurrentTable = false;
      i++;
      continue;
    }

    // Standalone HTML comment
    const withoutInline = trimmed.replace(/`[^`]*`/g, "");
    if (/^<!--[\s\S]*-->$/.test(trimmed)) {
      if (/<!--\s*codefog-ignore-next\s*-->/i.test(withoutInline)) {
        ignoreNextBlock = true;
      }
      i++;
      continue;
    }

    // Fenced code block
    const fenceOpen = /^\s*(`{3,}|~{3,})([^\n]*)$/.exec(line);
    if (fenceOpen) {
      ignoreCurrentTable = false;
      const fenceChars = fenceOpen[1]!;
      const fenceChar = fenceChars[0]!;
      const fenceLen = fenceChars.length;
      const infoString = (fenceOpen[2] ?? "").trim();
      const language = infoString.split(/\s+/)[0]?.toLowerCase() ?? "";
      const startLine = lineNum;
      const codeLines: string[] = [];
      const rawLines: string[] = [line];
      i++;
      while (i < lines.length) {
        const curLine = lines[i]!;
        rawLines.push(curLine);
        const closeMatch = new RegExp(`^\\s*${fenceChar}{${fenceLen},}\\s*$`).exec(curLine);
        if (closeMatch) {
          i++;
          break;
        }
        codeLines.push(curLine);
        i++;
      }
      const endLine = i;
      const rawText = rawLines.join("\n");
      const blockIgnored = ignoredFile || ignoreNextBlock;
      ignoreNextBlock = false;
      blocks.push({
        kind: "code-block",
        startLine,
        endLine,
        rawText,
        normalizedText: rawText.replace(/\s+/g, ""),
        ignored: blockIgnored,
        language,
        codeContent: codeLines.join("\n"),
      });
      continue;
    }

    if (isHorizontalRule(line)) {
      ignoreCurrentTable = false;
      i++;
      continue;
    }

    // Heading
    const headingMatch = /^\s*(#{1,6})\s+(.+?)\s*#*$/.exec(line);
    if (headingMatch) {
      ignoreCurrentTable = false;
      const headingText = headingMatch[2]!.trim();
      const baseSlug = slugifyMarkdownHeading(headingText);
      const count = slugCounts.get(baseSlug) ?? 0;
      slugCounts.set(baseSlug, count + 1);
      const slug = count === 0 ? baseSlug : `${baseSlug}-${count}`;
      headings.push({ text: headingText, slug, line: lineNum });
      if (count > 0) {
        headings.push({ text: headingText, slug: baseSlug, line: lineNum });
      }
      const blockIgnored = ignoredFile || ignoreNextBlock;
      ignoreNextBlock = false;
      blocks.push({
        kind: "heading",
        startLine: lineNum,
        endLine: lineNum,
        rawText: line,
        normalizedText: line.replace(/\s+/g, ""),
        ignored: blockIgnored,
        headingSlug: slug,
      });
      i++;
      continue;
    }

    // Table row
    if (isTableLine(line)) {
      if (isTableSeparatorLine(line)) {
        i++;
        continue;
      }
      const nextLine = lines[i + 1];
      const isHeaderRow = nextLine !== undefined && isTableSeparatorLine(nextLine);
      if (isHeaderRow && ignoreNextBlock) {
        ignoreCurrentTable = true;
      }
      const blockIgnored = ignoredFile || ignoreNextBlock || ignoreCurrentTable;
      ignoreNextBlock = false;
      blocks.push({
        kind: "table-row",
        startLine: lineNum,
        endLine: lineNum,
        rawText: line,
        normalizedText: line.replace(/\s+/g, ""),
        ignored: blockIgnored,
      });
      i++;
      continue;
    }
    ignoreCurrentTable = false;

    // List item
    const listMatch = /^(\s*)(?:[-*+]|\d+[.)])\s+/.exec(line);
    if (listMatch) {
      const startLine = lineNum;
      const itemLines: string[] = [line];
      const blockIgnored = ignoredFile || ignoreNextBlock;
      ignoreNextBlock = false;
      i++;
      while (i < lines.length) {
        const nextL = lines[i]!;
        const nextTrim = nextL.trim();
        if (
          nextTrim === "" ||
          /^<!--[\s\S]*-->$/.test(nextTrim) ||
          /^\s*(`{3,}|~{3,})/.test(nextL) ||
          /^\s*#{1,6}\s+/.test(nextL) ||
          isTableLine(nextL) ||
          isHorizontalRule(nextL) ||
          /^\s*(?:[-*+]|\d+[.)])\s+/.test(nextL)
        ) {
          break;
        }
        if (/^\s{2,}|\t/.test(nextL)) {
          itemLines.push(nextL);
          i++;
        } else {
          break;
        }
      }
      const rawText = itemLines.join("\n");
      blocks.push({
        kind: "list-item",
        startLine,
        endLine: startLine + itemLines.length - 1,
        rawText,
        normalizedText: rawText.replace(/\s+/g, ""),
        ignored: blockIgnored,
      });
      continue;
    }

    // Paragraph
    const startLine = lineNum;
    const paraLines: string[] = [line];
    const blockIgnored = ignoredFile || ignoreNextBlock;
    ignoreNextBlock = false;
    i++;
    while (i < lines.length) {
      const nextL = lines[i]!;
      const nextTrim = nextL.trim();
      if (
        nextTrim === "" ||
        /^<!--[\s\S]*-->$/.test(nextTrim) ||
        /^\s*(`{3,}|~{3,})/.test(nextL) ||
        /^\s*#{1,6}\s+/.test(nextL) ||
        isTableLine(nextL) ||
        isHorizontalRule(nextL) ||
        /^\s*(?:[-*+]|\d+[.)])\s+/.test(nextL)
      ) {
        break;
      }
      paraLines.push(nextL);
      i++;
    }
    const rawText = paraLines.join("\n");
    blocks.push({
      kind: "paragraph",
      startLine,
      endLine: startLine + paraLines.length - 1,
      rawText,
      normalizedText: rawText.replace(/\s+/g, ""),
      ignored: blockIgnored,
    });
  }

  return {
    file,
    content,
    lines,
    ignoredFile,
    headings,
    blocks,
  };
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

function looksLikePathToken(token: string): boolean {
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

function isRepoSourceFile(relPath: string): boolean {
  const norm = toPosix(relPath);
  if (isRepoTestFile(norm)) return false;
  if (norm.endsWith(".d.ts")) return false;
  return /\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(norm) || isPolyglotSourceFile(norm);
}

export function extractSymbolsFromSource(sourceText: string, filePath: string): RepoSymbol[] {
  const relPath = toPosix(filePath);
  const symbols: RepoSymbol[] = [];

  if (isPolyglotSourceFile(relPath)) {
    const adapter = getPolyglotAdapter(relPath);
    const fnSpans = adapter?.extractFunctionSpans(sourceText, relPath) ?? [];
    for (const span of fnSpans) {
      symbols.push({
        name: span.name,
        kind: "function",
        file: relPath,
        startLine: span.startLine,
        endLine: span.endLine,
        runtimeFingerprint: span.runtimeFingerprint,
      });
    }

    const { noComments, masked } = stripCommentsAndMaskStrings(sourceText);
    const lines = masked.split("\n");
    const noCommentLines = noComments.split("\n");
    const typeRe =
      relPath.endsWith(".go")
        ? /^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(?:struct|interface)\b/
        : relPath.endsWith(".rs")
          ? /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+([A-Za-z_][A-Za-z0-9_]*)\b/
          : /^\s*(?:(?:public|protected|private|abstract|final|static)\s+)*(?:class|enum|record|interface)\s+([A-Za-z_][A-Za-z0-9_]*)\b/;

    for (let idx = 0; idx < lines.length; idx++) {
      const m = typeRe.exec(lines[idx]!);
      if (m && m[1]) {
        const typeName = m[1];
        const lineNum = idx + 1;
        symbols.push({
          name: typeName,
          kind: "class",
          file: relPath,
          startLine: lineNum,
          endLine: lineNum,
          runtimeFingerprint: `class:${typeName}:${(noCommentLines[idx] ?? "").trim()}`,
        });
      }
    }

    return symbols.sort((a, b) => a.startLine - b.startLine);
  }

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
  const byFile = new Map<string, RepoSymbol[]>();

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
      const list = byName.get(sym.name) ?? [];
      list.push(sym);
      byName.set(sym.name, list);
      if (sym.qualifiedName) {
        const qList = byQualifiedName.get(sym.qualifiedName) ?? [];
        qList.push(sym);
        byQualifiedName.set(sym.qualifiedName, qList);
      }
    }
  }

  return { byName, byQualifiedName, byFile };
}

function parseCandidateSymbolToken(code: string): {
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
      qualifiedName: normalized,
      bareName: parts[parts.length - 1],
    };
  }

  return null;
}

function resolveSymbolInIndex(
  candidate: { bareName?: string; qualifiedName?: string },
  symbolIndex: RepoSymbolIndex,
): RepoSymbol[] {
  if (candidate.qualifiedName) {
    const byQual = symbolIndex.byQualifiedName.get(candidate.qualifiedName);
    if (byQual && byQual.length > 0) return byQual;
  }
  if (candidate.bareName && ! candidate.qualifiedName) {
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
): "install" | "build" | "test" | "lint" | "typecheck" | undefined {
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
    /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?typecheck(?::\S+)?(?:\s|$)/.test(cmd) ||
    /^(?:npx\s+|pnpm\s+(?:exec\s+|dlx\s+)?|yarn\s+|bunx\s+)?tsc\s+[^\n]*--noEmit(?:\s|$)/.test(
      cmd,
    )
  ) {
    return "typecheck";
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

function extractSubcommandsFromCliSource(sourceText: string, binNames: Set<string>): Set<string> {
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

async function resolveInlineCommandClaim(
  code: string,
  rootDir: string,
  pkgInfo: PackageManifestInfo,
  isInstruction = false,
): Promise<{
  target: string;
  state: EvidenceState;
  referent?: DocReferent;
  commandIntent?: "install" | "build" | "test" | "lint" | "typecheck";
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
      target: trimmed,
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
      target: trimmed,
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
        target: trimmed,
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
          target: trimmed,
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
          target: trimmed,
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
      target: trimmed,
      state: "weak-evidence",
      commandIntent,
    };
  }

  return null;
}

async function checkExternalUrlReachable(url: string): Promise<boolean> {
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

async function pathExists(absPath: string): Promise<boolean> {
  try {
    await fs.access(absPath);
    return true;
  } catch {
    return false;
  }
}

export async function analyzeDocClaims(options: {
  rootDir: string;
  checkExternalLinks?: boolean;
  runDocs?: boolean;
}): Promise<DocAnalysisResult> {
  const rootDir = path.resolve(options.rootDir);
  const [docFiles, symbolIndex, gitignoreMatchers, pkgInfo, gitSession] = await Promise.all([
    discoverDocFiles(rootDir),
    buildRepoSymbolIndex(rootDir),
    loadGitignoreMatchers(rootDir),
    loadPackageManifestInfo(rootDir),
    createGitTimelineSession(rootDir),
  ]);
  const parsedDocs: ParsedDocFile[] = [];
  const parsedDocsByPath = new Map<string, ParsedDocFile>();

  for (const relPath of docFiles) {
    try {
      const content = await fs.readFile(path.join(rootDir, relPath), "utf8");
      const parsed = parseMarkdownDoc(relPath, content);
      parsedDocs.push(parsed);
      parsedDocsByPath.set(relPath, parsed);
    } catch {
      // skip unreadable file
    }
  }

  const parsedDocAtCommitCache = new Map<string, Promise<ParsedDocFile | null>>();
  const symbolsAtCommitCache = new Map<string, Promise<RepoSymbol[]>>();
  const symbolIndexAtCommitCache = new Map<string, Promise<RepoSymbolIndex>>();
  const pkgScriptsAtCommitCache = new Map<string, Promise<Map<string, string>>>();

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

  function getPackageScriptsAtCommit(sha: string): Promise<Map<string, string>> {
    let p = pkgScriptsAtCommitCache.get(sha);
    if (!p) {
      p = (async () => {
        const scripts = new Map<string, string>();
        const raw = await gitSession.getFileTextAtCommit(sha, "package.json");
        if (!raw) return scripts;
        try {
          const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
          if (parsed.scripts && typeof parsed.scripts === "object") {
            for (const [k, v] of Object.entries(parsed.scripts)) {
              if (typeof v === "string") {
                scripts.set(k, v);
              }
            }
          }
        } catch {
          // ignore malformed package.json
        }
        return scripts;
      })();
      pkgScriptsAtCommitCache.set(sha, p);
    }
    return p;
  }

  async function findScriptLastChangeCommit(
    scriptName: string,
    currentDef: string,
  ): Promise<RepoCommitInfo | null> {
    if (!gitSession.isGitRepo) return null;
    const pkgCommits = await gitSession.getFileCommits("package.json");
    if (pkgCommits.length === 0) {
      return {
        sha: "WORKTREE",
        shortSha: gitSession.commits[0]?.shortSha ?? "0000000",
        isoDate: new Date().toISOString(),
        index: -1,
      };
    }

    const headScripts = await getPackageScriptsAtCommit(pkgCommits[0]!.sha);
    if (headScripts.get(scriptName) !== currentDef) {
      return {
        sha: "WORKTREE",
        shortSha: gitSession.commits[0]?.shortSha ?? "0000000",
        isoDate: new Date().toISOString(),
        index: -1,
      };
    }

    for (let i = 0; i < pkgCommits.length; i++) {
      const cur = pkgCommits[i]!;
      const next = pkgCommits[i + 1];
      if (!next) return cur;
      const nextScripts = await getPackageScriptsAtCommit(next.sha);
      if (nextScripts.get(scriptName) !== currentDef) {
        return cur;
      }
    }

    return pkgCommits[pkgCommits.length - 1]!;
  }

  async function findFileLatestCommit(relPath: string): Promise<RepoCommitInfo | null> {
    if (!gitSession.isGitRepo) return null;
    const commits = await gitSession.getFileCommits(relPath);
    return commits[0] ?? null;
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
          .filter((rel) => {
            if (!isRepoSourceFile(rel)) return false;
            const segs = rel.split("/");
            return !segs.some(
              (s) =>
                s === "node_modules" ||
                s === "vendor" ||
                s === "dist" ||
                s === "coverage" ||
                s === ".codefog" ||
                s === "target" ||
                s === "build",
            );
          })
          .sort((a, b) => a.localeCompare(b));

        for (const relPath of sortedFiles) {
          const fileSyms = await getFileSymbolsAtCommit(sha, relPath);
          byFile.set(relPath, fileSyms);
          for (const sym of fileSyms) {
            const list = byName.get(sym.name) ?? [];
            list.push(sym);
            byName.set(sym.name, list);
            if (sym.qualifiedName) {
              const qList = byQualifiedName.get(sym.qualifiedName) ?? [];
              qList.push(sym);
              byQualifiedName.set(sym.qualifiedName, qList);
            }
          }
        }

        return { byName, byQualifiedName, byFile };
      })();
      symbolIndexAtCommitCache.set(sha, p);
    }
    return p;
  }

  async function findSymbolRemovalCommit(sym: RepoSymbol): Promise<RepoCommitInfo | null> {
    if (!gitSession.isGitRepo) return null;
    const fileCommits = await gitSession.getFileCommits(sym.file);
    if (fileCommits.length === 0) return gitSession.commits[0] ?? null;

    const matchSym = (list: RepoSymbol[]): RepoSymbol | undefined =>
      sym.qualifiedName
        ? list.find((s) => s.qualifiedName === sym.qualifiedName) ??
          list.find((s) => s.name === sym.name)
        : list.find((s) => s.name === sym.name);

    for (let i = 0; i < fileCommits.length; i++) {
      const cur = fileCommits[i]!;
      const next = fileCommits[i + 1];
      if (!next) return cur;
      const nextSyms = await getFileSymbolsAtCommit(next.sha, sym.file);
      if (matchSym(nextSyms)) {
        return cur;
      }
    }
    return fileCommits[0]!;
  }

  async function findBlockLastSubstantiveCommit(
    docFile: string,
    block: DocBlock,
  ): Promise<RepoCommitInfo | null> {
    if (!gitSession.isGitRepo) return null;
    const docCommits = await gitSession.getFileCommits(docFile);
    if (docCommits.length === 0) {
      return {
        sha: "WORKTREE",
        shortSha: gitSession.commits[0]?.shortSha ?? "0000000",
        isoDate: new Date().toISOString(),
        index: -1,
      };
    }

    const headDoc = await getParsedDocAtCommit(docCommits[0]!.sha, docFile);
    const hasNormalized = (parsed: ParsedDocFile | null): boolean =>
      Boolean(parsed?.blocks.some((b) => b.normalizedText === block.normalizedText));

    if (!hasNormalized(headDoc)) {
      return {
        sha: "WORKTREE",
        shortSha: gitSession.commits[0]?.shortSha ?? "0000000",
        isoDate: new Date().toISOString(),
        index: -1,
      };
    }

    for (let i = 0; i < docCommits.length; i++) {
      const cur = docCommits[i]!;
      const next = docCommits[i + 1];
      if (!next) return cur;
      const nextDoc = await getParsedDocAtCommit(next.sha, docFile);
      if (!hasNormalized(nextDoc)) {
        return cur;
      }
    }

    return docCommits[docCommits.length - 1]!;
  }

  async function findSymbolLastRuntimeChangeCommit(
    sym: RepoSymbol,
  ): Promise<RepoCommitInfo | null> {
    if (!gitSession.isGitRepo) return null;
    const fileCommits = await gitSession.getFileCommits(sym.file);
    if (fileCommits.length === 0) {
      return {
        sha: "WORKTREE",
        shortSha: gitSession.commits[0]?.shortSha ?? "0000000",
        isoDate: new Date().toISOString(),
        index: -1,
      };
    }

    const matchSym = (list: RepoSymbol[]): RepoSymbol | undefined =>
      sym.qualifiedName
        ? list.find((s) => s.qualifiedName === sym.qualifiedName) ??
          list.find((s) => s.name === sym.name)
        : list.find((s) => s.name === sym.name);

    const headSyms = await getFileSymbolsAtCommit(fileCommits[0]!.sha, sym.file);
    const symAtHead = matchSym(headSyms);
    if (!symAtHead || symAtHead.runtimeFingerprint !== sym.runtimeFingerprint) {
      return {
        sha: "WORKTREE",
        shortSha: gitSession.commits[0]?.shortSha ?? "0000000",
        isoDate: new Date().toISOString(),
        index: -1,
      };
    }

    for (let i = 0; i < fileCommits.length; i++) {
      const cur = fileCommits[i]!;
      const next = fileCommits[i + 1];
      if (!next) return cur;
      const nextSyms = await getFileSymbolsAtCommit(next.sha, sym.file);
      const symAtNext = matchSym(nextSyms);
      if (!symAtNext || symAtNext.runtimeFingerprint !== sym.runtimeFingerprint) {
        return cur;
      }
    }

    return fileCommits[fileCommits.length - 1]!;
  }

  const docClaims: DocClaim[] = [];

  for (const doc of parsedDocs) {
    if (doc.ignoredFile) continue;

    for (const block of doc.blocks) {
      if (block.ignored) continue;
      if (block.kind === "code-block") {
        const codeClaim = await evaluateDocCodeBlockClaim({
          rootDir,
          docFile: doc.file,
          block,
          runDocs: Boolean(options.runDocs),
          symbolIndex,
          pkgInfo,
        });
        if (codeClaim) {
          docClaims.push(codeClaim);
        }
        continue;
      }

      const blockCommit = await findBlockLastSubstantiveCommit(doc.file, block);
      const blockLines = doc.lines.slice(block.startLine - 1, block.endLine);
      for (let lineIdx = 0; lineIdx < blockLines.length; lineIdx++) {
        const rawLine = blockLines[lineIdx]!;
        const lineNum = block.startLine + lineIdx;
        const lineWithoutComments = rawLine.replace(/<!--[\s\S]*?-->/g, "");

        // 1. Extract Markdown links [label](target) (excluding images ![alt](src))
        const linkTargetsOnLine = new Set<string>();
        const linkRe = /(?<!\!)\[([^\]]*)\]\(([^)]+)\)/g;
        let lm: RegExpExecArray | null;
        while ((lm = linkRe.exec(lineWithoutComments)) !== null) {
          const rawHref = lm[2]!.trim().replace(/^<|>$/g, "").split(/\s+/)[0] ?? "";
          if (!rawHref || /^(?:mailto:|tel:|javascript:|data:)/i.test(rawHref)) {
            continue;
          }
          linkTargetsOnLine.add(rawHref);

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
              target: rawHref,
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
            const fileCommit = resolved ? await findFileLatestCommit(doc.file) : null;
            const referent: DocReferent | undefined = heading
              ? {
                  kind: "anchor",
                  file: doc.file,
                  anchor: anchorSlug,
                  startLine: heading.line,
                  endLine: heading.line,
                  ...(fileCommit
                    ? {
                        lastModifiedCommit: fileCommit.shortSha,
                        lastModifiedAt: fileCommit.isoDate,
                      }
                    : {}),
                }
              : undefined;
            let existedAtClaimCommit: boolean | undefined;
            if (!resolved && gitSession.isGitRepo && blockCommit) {
              const lookupSha =
                blockCommit.sha === "WORKTREE" ? gitSession.commits[0]?.sha : blockCommit.sha;
              if (lookupSha) {
                const histDoc = await getParsedDocAtCommit(lookupSha, doc.file);
                existedAtClaimCommit = Boolean(
                  histDoc?.headings.some((h) => h.slug === anchorSlug),
                );
              }
            }
            docClaims.push({
              id: createDeterministicFindingId(doc.file, `${lineNum}:${rawHref}`),
              file: doc.file,
              kind: "anchor",
              text: rawHref,
              rawText: rawHref,
              target: rawHref,
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
              target: rawHref,
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
            let targetDoc = parsedDocsByPath.get(resolvedRel);
            if (!targetDoc && resolvedRel.toLowerCase().endsWith(".md")) {
              try {
                const targetContent = await fs.readFile(path.join(rootDir, resolvedRel), "utf8");
                targetDoc = parseMarkdownDoc(resolvedRel, targetContent);
                parsedDocsByPath.set(resolvedRel, targetDoc);
              } catch {
                anchorValid = false;
              }
            }
            if (targetDoc) {
              anchorValid = targetDoc.headings.some(
                (h) => h.slug === anchorPart.toLowerCase(),
              );
            }
          }

          const state: EvidenceState = exists && anchorValid ? "verified" : "fog-returned";
          const fileCommit = await findFileLatestCommit(resolvedRel);
          let existedAtClaimCommit: boolean | undefined;
          if (state === "fog-returned" && gitSession.isGitRepo && blockCommit) {
            const lookupSha =
              blockCommit.sha === "WORKTREE" ? gitSession.commits[0]?.sha : blockCommit.sha;
            if (lookupSha) {
              const trackedAtCommit = await gitSession.listTrackedFilesAtCommit(lookupSha);
              if (!trackedAtCommit.has(resolvedRel)) {
                existedAtClaimCommit = false;
              } else if (anchorPart && resolvedRel.toLowerCase().endsWith(".md")) {
                const histDoc = await getParsedDocAtCommit(lookupSha, resolvedRel);
                existedAtClaimCommit = Boolean(
                  histDoc?.headings.some((h) => h.slug === anchorPart.toLowerCase()),
                );
              } else {
                existedAtClaimCommit = true;
              }
            }
          }
          const referent: DocReferent | undefined =
            exists && anchorValid
              ? {
                  kind: "file",
                  file: resolvedRel,
                  ...(anchorPart ? { anchor: anchorPart.toLowerCase() } : {}),
                  ...(fileCommit
                    ? {
                        lastModifiedCommit: fileCommit.shortSha,
                        lastModifiedAt: fileCommit.isoDate,
                      }
                    : {}),
                }
              : existedAtClaimCommit
                ? {
                    kind: "file",
                    file: resolvedRel,
                    ...(anchorPart ? { anchor: anchorPart.toLowerCase() } : {}),
                    ...(fileCommit
                      ? {
                          lastModifiedCommit: fileCommit.shortSha,
                          lastModifiedAt: fileCommit.isoDate,
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
            target: rawHref,
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
          if (!code || linkTargetsOnLine.has(code)) continue;

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
              const scriptCommit = await findScriptLastChangeCommit(
                cmdReferent.script,
                cmdReferent.scriptDefinition,
              );
              if (scriptCommit) {
                cmdReferent = {
                  ...cmdReferent,
                  lastModifiedCommit: scriptCommit.shortSha,
                  lastModifiedAt: scriptCommit.isoDate,
                };
              }
              if (blockCommit && scriptCommit && scriptCommit.index < blockCommit.index) {
                cmdState = "fog-returned";
                existedAtClaimCommit = true;
              }
            } else if (cmdReferent?.file) {
              const refCommit = await findFileLatestCommit(cmdReferent.file);
              if (refCommit) {
                cmdReferent = {
                  ...cmdReferent,
                  lastModifiedCommit: refCommit.shortSha,
                  lastModifiedAt: refCommit.isoDate,
                };
              }
            } else if (cmdState === "fog-returned" && gitSession.isGitRepo && blockCommit) {
              const lookupSha =
                blockCommit.sha === "WORKTREE" ? gitSession.commits[0]?.sha : blockCommit.sha;
              if (lookupSha) {
                const firstSeg = cmdClaim.target.split(/\s*(?:&&|\|\||;)\s*/)[0] ?? cmdClaim.target;
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
                  const histScripts = await getPackageScriptsAtCommit(lookupSha);
                  existedAtClaimCommit = histScripts.has(sName);
                } else if (nodeFileM?.[1]) {
                  const fArg = nodeFileM[1].replace(/^\.\//, "");
                  const tracked = await gitSession.listTrackedFilesAtCommit(lookupSha);
                  existedAtClaimCommit = tracked.has(fArg);
                } else {
                  existedAtClaimCommit = false;
                }
              }
            }

            docClaims.push({
              id: createDeterministicFindingId(doc.file, `${lineNum}:${code}`),
              file: doc.file,
              kind: "command",
              text: code,
              rawText: code,
              target: cmdClaim.target,
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
            const fileCommit = heading ? await findFileLatestCommit(doc.file) : null;
            const referent: DocReferent | undefined = heading
              ? {
                  kind: "anchor",
                  file: doc.file,
                  anchor: anchorSlug,
                  startLine: heading.line,
                  endLine: heading.line,
                  ...(fileCommit
                    ? {
                        lastModifiedCommit: fileCommit.shortSha,
                        lastModifiedAt: fileCommit.isoDate,
                      }
                    : {}),
                }
              : undefined;
            let existedAtClaimCommit: boolean | undefined;
            if (!heading && gitSession.isGitRepo && blockCommit) {
              const lookupSha =
                blockCommit.sha === "WORKTREE" ? gitSession.commits[0]?.sha : blockCommit.sha;
              if (lookupSha) {
                const histDoc = await getParsedDocAtCommit(lookupSha, doc.file);
                existedAtClaimCommit = Boolean(
                  histDoc?.headings.some((h) => h.slug === anchorSlug),
                );
              }
            }
            docClaims.push({
              id: createDeterministicFindingId(doc.file, `${lineNum}:${code}`),
              file: doc.file,
              kind: "anchor",
              text: code,
              rawText: code,
              target: code,
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
                target: code,
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
            const fileCommit = await findFileLatestCommit(cleanPath);
            let existedAtClaimCommit: boolean | undefined;
            if (!exists && gitSession.isGitRepo && blockCommit) {
              const lookupSha =
                blockCommit.sha === "WORKTREE" ? gitSession.commits[0]?.sha : blockCommit.sha;
              if (lookupSha) {
                const trackedAtCommit = await gitSession.listTrackedFilesAtCommit(lookupSha);
                existedAtClaimCommit = trackedAtCommit.has(cleanPath);
              }
            }
            const referent: DocReferent | undefined = exists
              ? {
                  kind: "file",
                  file: cleanPath,
                  ...(fileCommit
                    ? {
                        lastModifiedCommit: fileCommit.shortSha,
                        lastModifiedAt: fileCommit.isoDate,
                      }
                    : {}),
                }
              : existedAtClaimCommit
                ? {
                    kind: "file",
                    file: cleanPath,
                    ...(fileCommit
                      ? {
                          lastModifiedCommit: fileCommit.shortSha,
                          lastModifiedAt: fileCommit.isoDate,
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
              target: code,
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
              const targetName = symCandidate.qualifiedName ?? symCandidate.bareName ?? code;
              const referents: DocReferent[] = [];
              let staleReferent: DocReferent | undefined;

              for (const s of matchedSymbols) {
                const symCommit = await findSymbolLastRuntimeChangeCommit(s);
                const ref: DocReferent = {
                  kind: "symbol",
                  file: s.file,
                  symbol: s.name,
                  startLine: s.startLine,
                  endLine: s.endLine,
                  runtimeFingerprint: s.runtimeFingerprint,
                  ...(symCommit
                    ? {
                        lastModifiedCommit: symCommit.shortSha,
                        lastModifiedAt: symCommit.isoDate,
                      }
                    : {}),
                };
                referents.push(ref);
                if (blockCommit && symCommit && symCommit.index < blockCommit.index && !staleReferent) {
                  staleReferent = ref;
                }
              }

              const symState: EvidenceState = staleReferent ? "fog-returned" : "weak-evidence";
              docClaims.push({
                id: createDeterministicFindingId(doc.file, `${lineNum}:${code}`),
                file: doc.file,
                kind: "symbol",
                text: targetName,
                rawText: code,
                target: targetName,
                startLine: lineNum,
                endLine: lineNum,
                blockKind: block.kind,
                blockStartLine: block.startLine,
                blockEndLine: block.endLine,
                state: symState,
                referents,
                referent: staleReferent ?? referents[0],
                ...(gitSession.isGitRepo ? { existedAtClaimCommit: true } : {}),
              });
            } else if (gitSession.isGitRepo && blockCommit) {
              const lookupSha =
                blockCommit.sha === "WORKTREE" ? gitSession.commits[0]?.sha : blockCommit.sha;
              if (lookupSha) {
                const histIndex = await getSymbolIndexAtCommit(lookupSha);
                const histMatches = resolveSymbolInIndex(symCandidate, histIndex);
                if (histMatches.length > 0) {
                  const targetName = symCandidate.qualifiedName ?? symCandidate.bareName ?? code;
                  const referents: DocReferent[] = [];
                  for (const hs of histMatches) {
                    const removalCommit = await findSymbolRemovalCommit(hs);
                    referents.push({
                      kind: "symbol",
                      file: hs.file,
                      symbol: hs.name,
                      startLine: hs.startLine,
                      endLine: hs.endLine,
                      runtimeFingerprint: hs.runtimeFingerprint,
                      ...(removalCommit
                        ? {
                            lastModifiedCommit: removalCommit.shortSha,
                            lastModifiedAt: removalCommit.isoDate,
                          }
                        : {}),
                    });
                  }
                  docClaims.push({
                    id: createDeterministicFindingId(doc.file, `${lineNum}:${code}`),
                    file: doc.file,
                    kind: "symbol",
                    text: targetName,
                    rawText: code,
                    target: targetName,
                    startLine: lineNum,
                    endLine: lineNum,
                    blockKind: block.kind,
                    blockStartLine: block.startLine,
                    blockEndLine: block.endLine,
                    state: "fog-returned",
                    referents,
                    referent: referents[0],
                    existedAtClaimCommit: true,
                  });
                }
              }
            }
          }
        }
      }
    }
  }

  const docClaimsByState = emptyLocByState();
  const docFindings: Finding[] = [];

  // Detect conflicting commands across different AI instruction files by mapped commandIntent
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
          normalizeCommandForConflict(a.target) !==
            normalizeCommandForConflict(b.target)
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
      command: c.target,
    }));
    const conflictSummary = sortedClaims
      .map((c) => `${c.file}:${c.startLine} ('${c.target}')`)
      .join(" vs ");
    const locationRangeSummary = sortedClaims
      .map((c) => `${c.file}:${c.startLine}-${c.endLine}`)
      .join(", ");

    docFindings.push({
      id: createDeterministicFindingId(
        primary.file,
        `instruction-conflict:${intent}:${sortedClaims.map((c) => `${c.file}:${c.startLine}:${c.target}`).join("|")}`,
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
          command: `npx codefog verify ${claim.file} --lines ${claim.blockStartLine}-${claim.blockEndLine}`,
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
