import * as fs from "node:fs/promises";
import * as path from "node:path";

export type SupportedLanguageId = "ts" | "go" | "rust" | "java";

export interface PolyglotFunctionSpan {
  name: string;
  receiverType?: string;
  startLine: number;
  endLine: number;
  cyclomaticComplexity: number;
  returnSignature: string;
  runtimeFingerprint: string;
}

export interface PolyglotExtractedSymbol {
  name: string;
  qualifiedName?: string;
  kind: "function" | "class" | "method";
  file: string;
  startLine: number;
  endLine: number;
  runtimeFingerprint: string;
}

export interface PolyglotCandidateMutation {
  id: string;
  line: number;
  original: string;
  mutated: string;
  mutatedSource: string;
  isBodyClearance?: boolean;
}

export interface PolyglotAstEvidenceEntry {
  fileStem: string;
  symbol: string;
  executedBlocks: Set<string>;
  outcomeAssertedBlocks: Set<string>;
  livenessCheckedBlocks: Set<string>;
  directOutcomeAssertions: number;
  directLivenessChecks: number;
  testFiles: Set<string>;
}

export interface PolyglotRepoAstEvidence {
  evidenceEntries: PolyglotAstEvidenceEntry[];
  callGraphEdges: Map<string, Set<string>>;
}

export interface LanguageAdapter {
  readonly id: SupportedLanguageId;
  isSourceFile(filePath: string): boolean;
  isTestFile(filePath: string): boolean;
  extractFunctionSpans(sourceText: string, filePath: string): PolyglotFunctionSpan[];
  extractSymbols(sourceText: string, filePath: string): PolyglotExtractedSymbol[];
  extractRuntimeFingerprints(sourceText: string, filePath: string): Map<string, string>;
  generateCandidateMutations(
    sourceText: string,
    startLine?: number,
    endLine?: number,
  ): PolyglotCandidateMutation[];
  defaultTestCommand(rootDir: string, associatedTestFiles: string[]): Promise<string>;
  analyzeAstEvidence(
    rootDir: string,
    sourceFiles: string[],
    testFiles: string[],
  ): Promise<PolyglotRepoAstEvidence>;
  filterProductionLines?(
    lines: Map<number, number>,
    spans: PolyglotFunctionSpan[],
  ): void;
  extractInlineTestBlockFingerprints?(sourceText: string): Map<string, string>;
}

/**
 * Strips // line comments and /* block comments while preserving \n line breaks.
 * Also produces a `masked` string where string/char literals and comments are replaced
 * with spaces (preserving \n) for safe brace and keyword scanning.
 */
export function stripCommentsAndMaskStrings(source: string): {
  noComments: string;
  masked: string;
} {
  const noCommentsChars = Array.from(source);
  const maskedChars = Array.from(source);
  const len = source.length;
  let i = 0;

  while (i < len) {
    const ch = source[i]!;
    const next = source[i + 1];

    // Line comment //
    if (ch === "/" && next === "/") {
      while (i < len && source[i] !== "\n") {
        noCommentsChars[i] = " ";
        maskedChars[i] = " ";
        i++;
      }
      continue;
    }

    // Block comment /* ... */
    if (ch === "/" && next === "*") {
      noCommentsChars[i] = " ";
      maskedChars[i] = " ";
      i++;
      noCommentsChars[i] = " ";
      maskedChars[i] = " ";
      i++;
      while (i < len && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] !== "\n") {
          noCommentsChars[i] = " ";
          maskedChars[i] = " ";
        }
        i++;
      }
      if (i < len) {
        noCommentsChars[i] = " ";
        maskedChars[i] = " ";
        i++;
      }
      if (i < len) {
        noCommentsChars[i] = " ";
        maskedChars[i] = " ";
        i++;
      }
      continue;
    }

    // Double-quoted string "..."
    if (ch === '"') {
      maskedChars[i] = " ";
      i++;
      while (i < len && source[i] !== '"') {
        if (source[i] === "\\") {
          if (source[i] !== "\n") maskedChars[i] = " ";
          i++;
        }
        if (i < len && source[i] !== "\n") {
          maskedChars[i] = " ";
        }
        i++;
      }
      if (i < len) {
        maskedChars[i] = " ";
        i++;
      }
      continue;
    }

    // Backtick raw string `...`
    if (ch === "`") {
      maskedChars[i] = " ";
      i++;
      while (i < len && source[i] !== "`") {
        if (source[i] !== "\n") maskedChars[i] = " ";
        i++;
      }
      if (i < len) {
        maskedChars[i] = " ";
        i++;
      }
      continue;
    }

    // Single-quoted char/rune '...' (not Rust lifetime `'a` or `'static`)
    if (
      ch === "'" &&
      (source[i + 2] === "'" || (source[i + 1] === "\\" && source[i + 3] === "'"))
    ) {
      maskedChars[i] = " ";
      i++;
      while (i < len && source[i] !== "'" && source[i] !== "\n") {
        if (source[i] === "\\") {
          maskedChars[i] = " ";
          i++;
        }
        if (i < len && source[i] !== "\n") maskedChars[i] = " ";
        i++;
      }
      if (i < len && source[i] === "'") {
        maskedChars[i] = " ";
        i++;
      }
      continue;
    }

    i++;
  }

  return {
    noComments: noCommentsChars.join(""),
    masked: maskedChars.join(""),
  };
}

export function findMatchingDelimiter(
  masked: string,
  openIdx: number,
  openChar: string,
  closeChar: string,
): number {
  let depth = 0;
  for (let i = openIdx; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function buildLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function offsetToLine(lineStarts: number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lineStarts[mid]! <= offset) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return high + 1;
}

function countComplexityInMaskedSlice(
  maskedSlice: string,
  lang: "go" | "rust" | "java" = "go",
): number {
  let complexity = 1;
  const branchKeywords =
    lang === "rust"
      ? /\b(if|for|while|loop)\b/g
      : /\b(if|for|while|case|catch)\b/g;
  const logicalOps = /(&&|\|\|)/g;
  const m1 = maskedSlice.match(branchKeywords);
  if (m1) complexity += m1.length;
  const m2 = maskedSlice.match(logicalOps);
  if (m2) complexity += m2.length;
  if (lang === "rust") {
    const matchArms = maskedSlice.match(/=>/g);
    if (matchArms && matchArms.length > 1) {
      complexity += matchArms.length - 1;
    }
    const tryOps = maskedSlice.match(/\?[;,)\s]/g);
    if (tryOps) {
      complexity += tryOps.length;
    }
  }
  return complexity;
}

function createEvidenceAccumulator(): {
  evidenceMap: Map<string, PolyglotAstEvidenceEntry>;
  getOrCreateEv: (fileStem: string, symbol: string) => PolyglotAstEvidenceEntry;
} {
  const evidenceMap = new Map<string, PolyglotAstEvidenceEntry>();
  function getOrCreateEv(fileStem: string, symbol: string): PolyglotAstEvidenceEntry {
    const key = `${fileStem}::${symbol}`;
    let entry = evidenceMap.get(key);
    if (!entry) {
      entry = {
        fileStem,
        symbol,
        executedBlocks: new Set(),
        outcomeAssertedBlocks: new Set(),
        livenessCheckedBlocks: new Set(),
        directOutcomeAssertions: 0,
        directLivenessChecks: 0,
        testFiles: new Set(),
      };
      evidenceMap.set(key, entry);
    }
    return entry;
  }
  return { evidenceMap, getOrCreateEv };
}

function collectOperatorMutations(params: {
  sourceText: string;
  noComments: string;
  startLine?: number;
  endLine?: number;
  skipOffset?: (offset: number) => boolean;
  addMutation: (
    startOffset: number,
    endOffset: number,
    replacement: string,
    line: number,
  ) => void;
}): void {
  const { sourceText, noComments, startLine, endLine, skipOffset, addMutation } = params;
  const rawLines = sourceText.split("\n");
  const cleanLines = noComments.split("\n");
  let lineOffset = 0;

  const opRules: Array<{ pattern: RegExp; replacements: string[] }> = [
    {
      pattern: /([A-Za-z0-9_)\]."']+)\s*<=\s*([A-Za-z0-9_([\]\-"'`]+)/g,
      replacements: ["<", ">"],
    },
    {
      pattern: /([A-Za-z0-9_)\]."']+)\s*>=\s*([A-Za-z0-9_([\]\-"'`]+)/g,
      replacements: [">", "<"],
    },
    {
      pattern: /([A-Za-z0-9_)\]."']+)\s*==\s*([A-Za-z0-9_([\]\-"'`]+)/g,
      replacements: ["!="],
    },
    {
      pattern: /([A-Za-z0-9_)\]."']+)\s*!=\s*([A-Za-z0-9_([\]\-"'`]+)/g,
      replacements: ["=="],
    },
  ];

  for (let idx = 0; idx < rawLines.length; idx++) {
    const lineNum = idx + 1;
    const rawLine = rawLines[idx]!;
    const cLine = cleanLines[idx]!;
    const inRange =
      (startLine === undefined || lineNum >= startLine) &&
      (endLine === undefined || lineNum <= endLine);

    if (inRange && (!skipOffset || !skipOffset(lineOffset))) {
      for (const rule of opRules) {
        rule.pattern.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = rule.pattern.exec(cLine)) !== null) {
          const matchStart = lineOffset + m.index;
          if (skipOffset && skipOffset(matchStart)) continue;
          const matchEnd = matchStart + m[0].length;
          if (m.length >= 3 && m[1] && m[2]) {
            const left = rawLine.slice(m.index, m.index + m[1].length);
            const right = rawLine.slice(
              m.index + m[0].length - m[2].length,
              m.index + m[0].length,
            );
            for (const op of rule.replacements) {
              addMutation(matchStart, matchEnd, `${left} ${op} ${right}`, lineNum);
            }
          }
        }
      }
    }
    lineOffset += rawLine.length + 1;
  }
}

export async function findFilesByExtensionInRepo(
  dir: string,
  rootDir: string,
  ext: string,
  out: string[] = [],
): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (
      entry.name === "node_modules" ||
      entry.name === ".git" ||
      entry.name === "vendor" ||
      entry.name === "target" ||
      entry.name === "build" ||
      entry.name === "dist" ||
      entry.name === "coverage" ||
      entry.name === ".codefog" ||
      entry.name === ".idea" ||
      entry.name === ".vscode" ||
      entry.name === ".gradle"
    ) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await findFilesByExtensionInRepo(full, rootDir, ext, out);
    } else if (entry.name.endsWith(ext)) {
      out.push(path.relative(rootDir, full).replace(/\\/g, "/"));
    }
  }
  return out;
}

// ============================================================================
// Go LanguageAdapter
// ============================================================================

export function extractGoFunctionSpans(sourceText: string): PolyglotFunctionSpan[] {
  const { noComments, masked } = stripCommentsAndMaskStrings(sourceText);
  const lineStarts = buildLineStarts(sourceText);
  const spans: PolyglotFunctionSpan[] = [];

  const funcRegex = /^[ \t]*func\b/gm;
  let match: RegExpExecArray | null;

  while ((match = funcRegex.exec(masked)) !== null) {
    const funcStartIdx = match.index;
    let cursor = funcStartIdx + match[0].length;

    while (cursor < masked.length && /\s/.test(masked[cursor]!)) cursor++;
    let receiverType: string | undefined;
    if (masked[cursor] === "(") {
      const closeRecv = findMatchingDelimiter(masked, cursor, "(", ")");
      if (closeRecv === -1) continue;
      const recvInner = noComments.slice(cursor + 1, closeRecv).trim();
      const recvMatch = /\*?\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\[[^\]]*\])?\s*$/.exec(recvInner);
      if (recvMatch?.[1]) {
        receiverType = recvMatch[1];
      }
      cursor = closeRecv + 1;
    }

    while (cursor < masked.length && /\s/.test(masked[cursor]!)) cursor++;
    const nameMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(masked.slice(cursor));
    if (!nameMatch) continue;
    const fnName = nameMatch[0];
    cursor += fnName.length;

    while (cursor < masked.length && /\s/.test(masked[cursor]!)) cursor++;
    if (masked[cursor] === "[") {
      const closeGen = findMatchingDelimiter(masked, cursor, "[", "]");
      if (closeGen === -1) continue;
      cursor = closeGen + 1;
    }

    while (cursor < masked.length && /\s/.test(masked[cursor]!)) cursor++;
    if (masked[cursor] !== "(") continue;
    const closeParams = findMatchingDelimiter(masked, cursor, "(", ")");
    if (closeParams === -1) continue;
    cursor = closeParams + 1;

    const openBraceIdx = masked.indexOf("{", cursor);
    if (openBraceIdx === -1) continue;
    const closeBraceIdx = findMatchingDelimiter(masked, openBraceIdx, "{", "}");
    if (closeBraceIdx === -1) continue;

    const returnSignature = noComments.slice(cursor, openBraceIdx).trim();
    const startLine = offsetToLine(lineStarts, funcStartIdx);
    const endLine = offsetToLine(lineStarts, closeBraceIdx);
    const bodyMasked = masked.slice(openBraceIdx, closeBraceIdx + 1);
    const runtimeSlice = noComments
      .slice(funcStartIdx, closeBraceIdx + 1)
      .replace(/\s+/g, " ")
      .trim();

    spans.push({
      name: fnName,
      ...(receiverType ? { receiverType } : {}),
      startLine,
      endLine,
      cyclomaticComplexity: countComplexityInMaskedSlice(bodyMasked, "go"),
      returnSignature,
      runtimeFingerprint: `${fnName}:${runtimeSlice}`,
    });

    funcRegex.lastIndex = closeBraceIdx + 1;
  }

  return spans;
}

export function extractGoSymbols(
  sourceText: string,
  filePath: string,
): PolyglotExtractedSymbol[] {
  const relPath = filePath.replace(/\\/g, "/");
  const { noComments, masked } = stripCommentsAndMaskStrings(sourceText);
  const lineStarts = buildLineStarts(sourceText);
  const pkgMatch = /^\s*package\s+([A-Za-z_][A-Za-z0-9_]*)\b/m.exec(noComments);
  const pkgName = pkgMatch?.[1];

  const symbols: PolyglotExtractedSymbol[] = [];
  for (const span of extractGoFunctionSpans(sourceText)) {
    const qualifiedName = span.receiverType
      ? `${span.receiverType}.${span.name}`
      : pkgName
        ? `${pkgName}.${span.name}`
        : undefined;
    symbols.push({
      name: span.name,
      ...(qualifiedName ? { qualifiedName } : {}),
      kind: span.receiverType ? "method" : "function",
      file: relPath,
      startLine: span.startLine,
      endLine: span.endLine,
      runtimeFingerprint: span.runtimeFingerprint,
    });
  }

  const typeRe = /^[ \t]*type[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]+(?:struct|interface)\b/gm;
  let m: RegExpExecArray | null;
  while ((m = typeRe.exec(masked)) !== null) {
    const typeName = m[1]!;
    const declStart = m.index;
    const lineEnd = masked.indexOf("\n", declStart);
    const searchEnd = lineEnd === -1 ? masked.length : lineEnd;
    const openBraceIdx = masked.indexOf("{", declStart + m[0].length);
    let endOffset = searchEnd;
    if (openBraceIdx !== -1 && openBraceIdx <= searchEnd) {
      const closeBraceIdx = findMatchingDelimiter(masked, openBraceIdx, "{", "}");
      if (closeBraceIdx !== -1) {
        endOffset = closeBraceIdx + 1;
      }
    }
    const startLine = offsetToLine(lineStarts, declStart);
    const endLine = offsetToLine(lineStarts, Math.max(declStart, endOffset - 1));
    const bodyFp = noComments
      .slice(declStart, endOffset)
      .replace(/\s+/g, " ")
      .trim();
    symbols.push({
      name: typeName,
      ...(pkgName ? { qualifiedName: `${pkgName}.${typeName}` } : {}),
      kind: "class",
      file: relPath,
      startLine,
      endLine,
      runtimeFingerprint: `class:${typeName}:${bodyFp}`,
    });
  }

  return symbols.sort((a, b) => a.startLine - b.startLine);
}

function isGoErrorOnlyReturn(returnSignature: string): boolean {
  const sig = returnSignature.trim().replace(/^\(|\)$/g, "").trim();
  if (!sig) return false;
  const parts = sig
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length !== 1) return false;
  const sole = parts[0]!;
  return sole === "error" || sole.endsWith(" error");
}

function goZeroValueForType(rawType: string): { expr: string; prelude?: string } {
  const tokens = rawType.trim().split(/\s+/);
  const t = tokens[tokens.length - 1] ?? "";
  if (t === "bool") return { expr: "false" };
  if (t === "string") return { expr: '""' };
  if (
    t === "error" ||
    t === "any" ||
    t.startsWith("*") ||
    t.startsWith("[]") ||
    t.startsWith("map[") ||
    t.startsWith("chan ") ||
    t.startsWith("func(") ||
    t.startsWith("interface{")
  ) {
    return { expr: "nil" };
  }
  if (/^(u?int(8|16|32|64|ptr)?|byte|rune|float(32|64)|complex(64|128))$/.test(t)) {
    return { expr: "0" };
  }
  return { expr: "_cfZero", prelude: `var _cfZero ${t}; ` };
}

export function buildGoZeroReturnBody(returnSignature: string): string {
  const sig = returnSignature.trim();
  if (!sig) return "{ return }";

  const unwrapped = sig.startsWith("(") && sig.endsWith(")") ? sig.slice(1, -1).trim() : sig;
  if (!unwrapped) return "{ return }";

  const parts = unwrapped
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  const preludes: string[] = [];
  const exprs: string[] = [];
  parts.forEach((p, idx) => {
    const z = goZeroValueForType(p);
    if (z.prelude) {
      const varName = `_cfZero${idx}`;
      preludes.push(z.prelude.replace("_cfZero", varName));
      exprs.push(varName);
    } else {
      exprs.push(z.expr);
    }
  });

  return `{ ${preludes.join("")}return ${exprs.join(", ")} }`;
}

export function generateGoCandidateMutations(
  sourceText: string,
  startLine?: number,
  endLine?: number,
): PolyglotCandidateMutation[] {
  const { noComments, masked } = stripCommentsAndMaskStrings(sourceText);
  const lineStarts = buildLineStarts(sourceText);
  const candidates: PolyglotCandidateMutation[] = [];
  let seq = 1;

  function addMutation(
    startOffset: number,
    endOffset: number,
    replacement: string,
    line: number,
    isBodyClearance = false,
  ): void {
    const original = sourceText.slice(startOffset, endOffset);
    if (original === replacement) return;
    candidates.push({
      id: `mut_${seq++}`,
      line,
      original,
      mutated: replacement,
      mutatedSource:
        sourceText.slice(0, startOffset) + replacement + sourceText.slice(endOffset),
      isBodyClearance,
    });
  }

  const funcRegex = /^[ \t]*func\b/gm;
  let match: RegExpExecArray | null;
  while ((match = funcRegex.exec(masked)) !== null) {
    const funcStartIdx = match.index;
    let cursor = funcStartIdx + match[0].length;
    while (cursor < masked.length && /\s/.test(masked[cursor]!)) cursor++;
    if (masked[cursor] === "(") {
      const closeRecv = findMatchingDelimiter(masked, cursor, "(", ")");
      if (closeRecv === -1) continue;
      cursor = closeRecv + 1;
    }
    while (cursor < masked.length && /\s/.test(masked[cursor]!)) cursor++;
    const nameMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(masked.slice(cursor));
    if (!nameMatch) continue;
    cursor += nameMatch[0].length;
    while (cursor < masked.length && /\s/.test(masked[cursor]!)) cursor++;
    if (masked[cursor] === "[") {
      const closeGen = findMatchingDelimiter(masked, cursor, "[", "]");
      if (closeGen === -1) continue;
      cursor = closeGen + 1;
    }
    while (cursor < masked.length && /\s/.test(masked[cursor]!)) cursor++;
    if (masked[cursor] !== "(") continue;
    const closeParams = findMatchingDelimiter(masked, cursor, "(", ")");
    if (closeParams === -1) continue;
    cursor = closeParams + 1;

    const openBraceIdx = masked.indexOf("{", cursor);
    if (openBraceIdx === -1) continue;
    const closeBraceIdx = findMatchingDelimiter(masked, openBraceIdx, "{", "}");
    if (closeBraceIdx === -1) continue;

    const fnStartLine = offsetToLine(lineStarts, funcStartIdx);
    const fnEndLine = offsetToLine(lineStarts, closeBraceIdx);
    const overlapsRange =
      (startLine === undefined || fnEndLine >= startLine) &&
      (endLine === undefined || fnStartLine <= endLine);

    if (overlapsRange) {
      const returnSignature = noComments.slice(cursor, openBraceIdx).trim();
      const zeroBody = buildGoZeroReturnBody(returnSignature);
      const bodyLine = offsetToLine(lineStarts, openBraceIdx);
      addMutation(openBraceIdx, closeBraceIdx + 1, zeroBody, bodyLine, true);
    }

    funcRegex.lastIndex = closeBraceIdx + 1;
  }

  collectOperatorMutations({
    sourceText,
    noComments,
    startLine,
    endLine,
    addMutation: (s, e, rep, ln) => addMutation(s, e, rep, ln, false),
  });

  return candidates;
}

export interface GoFunctionAstMeta {
  name: string;
  fileStem: string;
  pkgDir: string;
  returnsErrorOnly: boolean;
  calledSymbols: string[];
}

function parseGoImports(content: string, goModulePrefix?: string): Map<string, string> {
  const map = new Map<string, string>();
  const addImport = (alias: string | undefined, pkgPath: string) => {
    let relPkg = pkgPath;
    if (goModulePrefix && pkgPath.startsWith(goModulePrefix + "/")) {
      relPkg = pkgPath.slice(goModulePrefix.length + 1);
    }
    const parts = relPkg.split("/");
    const effectiveAlias = alias && alias !== "." && alias !== "_" ? alias : parts[parts.length - 1]!;
    map.set(effectiveAlias, relPkg);
  };

  const singleRe = /^\s*import\s+(?:([A-Za-z_]\w*)\s+)?"([^"]+)"/gm;
  let sm: RegExpExecArray | null;
  while ((sm = singleRe.exec(content)) !== null) {
    addImport(sm[1], sm[2]!);
  }

  const blockRe = /\bimport\s*\(([\s\S]*?)\)/g;
  let bm: RegExpExecArray | null;
  while ((bm = blockRe.exec(content)) !== null) {
    const lineRe = /^\s*(?:([A-Za-z_]\w*)\s+)?"([^"]+)"/gm;
    let lm: RegExpExecArray | null;
    while ((lm = lineRe.exec(bm[1]!)) !== null) {
      addImport(lm[1], lm[2]!);
    }
  }
  return map;
}

export async function analyzeGoFilesAstEvidence(
  rootDir: string,
  goSourceFiles: string[],
  goTestFiles: string[],
): Promise<PolyglotRepoAstEvidence> {
  const toPosix = (p: string) => p.replace(/\\/g, "/");
  const stripExt = (p: string) => p.replace(/\.go$/, "");

  let goModulePrefix: string | undefined;
  try {
    const goMod = await fs.readFile(path.join(rootDir, "go.mod"), "utf8");
    const m = /^\s*module\s+(\S+)/m.exec(goMod);
    goModulePrefix = m?.[1];
  } catch {
    // optional go.mod
  }

  const goFunctionsByKey = new Map<string, GoFunctionAstMeta>();
  const goFunctionsByPkgAndName = new Map<string, GoFunctionAstMeta[]>();
  const goFunctionsByName = new Map<string, GoFunctionAstMeta[]>();
  const callGraphEdges = new Map<string, Set<string>>();

  for (const srcRel of goSourceFiles) {
    const fullPath = path.join(rootDir, srcRel);
    let content = "";
    try {
      content = await fs.readFile(fullPath, "utf8");
    } catch {
      continue;
    }
    const spans = extractGoFunctionSpans(content);
    const { noComments } = stripCommentsAndMaskStrings(content);
    const lines = noComments.split("\n");
    const fileStem = stripExt(toPosix(srcRel));
    const pkgDir = toPosix(path.dirname(srcRel));

    for (const span of spans) {
      const bodyText = lines.slice(span.startLine - 1, span.endLine).join("\n");
      const calledSymbols: string[] = [];
      const callRe = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
      let cm: RegExpExecArray | null;
      while ((cm = callRe.exec(bodyText)) !== null) {
        const callee = cm[1]!;
        if (
          callee !== span.name &&
          !/^(if|for|switch|return|func|make|len|cap|append|new|panic)$/.test(callee)
        ) {
          calledSymbols.push(callee);
        }
      }

      const meta: GoFunctionAstMeta = {
        name: span.name,
        fileStem,
        pkgDir,
        returnsErrorOnly: isGoErrorOnlyReturn(span.returnSignature),
        calledSymbols,
      };
      const key = `${fileStem}::${span.name}`;
      goFunctionsByKey.set(key, meta);

      const pkgKey = `${pkgDir}::${span.name}`;
      const pkgList = goFunctionsByPkgAndName.get(pkgKey) ?? [];
      pkgList.push(meta);
      goFunctionsByPkgAndName.set(pkgKey, pkgList);

      const nameList = goFunctionsByName.get(span.name) ?? [];
      nameList.push(meta);
      goFunctionsByName.set(span.name, nameList);
    }
  }

  for (const [callerKey, meta] of goFunctionsByKey.entries()) {
    const edges = new Set<string>();
    for (const calleeName of meta.calledSymbols) {
      const samePkg = goFunctionsByPkgAndName.get(`${meta.pkgDir}::${calleeName}`);
      const targets = samePkg ?? goFunctionsByName.get(calleeName) ?? [];
      for (const t of targets) {
        edges.add(`${t.fileStem}::${t.name}`);
      }
    }
    callGraphEdges.set(callerKey, edges);
  }

  const { evidenceMap, getOrCreateEv } = createEvidenceAccumulator();

  for (const testRel of goTestFiles) {
    const fullPath = path.join(rootDir, testRel);
    let content = "";
    try {
      content = await fs.readFile(fullPath, "utf8");
    } catch {
      continue;
    }

    const testPkgDir = toPosix(path.dirname(testRel));
    const imports = parseGoImports(content, goModulePrefix);
    const testSpans = extractGoFunctionSpans(content);
    const { noComments } = stripCommentsAndMaskStrings(content);
    const allLines = noComments.split("\n");
    let blockCounter = 0;

    for (const testSpan of testSpans) {
      if (!testSpan.name.startsWith("Test")) continue;
      const blockId = `${testRel}#${++blockCounter}`;
      const bodyLines = allLines.slice(testSpan.startLine - 1, testSpan.endLine);
      const bodyText = bodyLines.join("\n");

      const valueVarToTargets = new Map<string, GoFunctionAstMeta[]>();
      const errVarToTargets = new Map<string, GoFunctionAstMeta[]>();
      const calledTargetsInBlock = new Map<string, GoFunctionAstMeta>();
      const outcomeForTarget = new Map<string, number>();
      const livenessForTarget = new Map<string, number>();

      function resolveGoTarget(calleeName: string, pkgAlias?: string): GoFunctionAstMeta[] {
        if (pkgAlias && imports.has(pkgAlias)) {
          const importedPkgDir = imports.get(pkgAlias)!;
          const fromImp = goFunctionsByPkgAndName.get(`${importedPkgDir}::${calleeName}`);
          if (fromImp) return fromImp;
        }
        return (
          goFunctionsByPkgAndName.get(`${testPkgDir}::${calleeName}`) ??
          goFunctionsByName.get(calleeName) ??
          []
        );
      }

      // 1. Scan assignments
      const assignRe =
        /([A-Za-z0-9_, \t]+?)\s*(?::=|=)\s*(?:([A-Za-z0-9_]+)\.)?([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)\n]*)\)/g;
      let am: RegExpExecArray | null;
      while ((am = assignRe.exec(bodyText)) !== null) {
        const lhsRaw = am[1]!.trim().replace(/^\b(if|var)\b\s*/, "").trim();
        const pkgAlias = am[2];
        const calleeName = am[3]!;
        const callArgs = am[4] ?? "";

        // Handle `diff := cmp.Diff(want, got)` or `eq := reflect.DeepEqual(got, want)` where `got` is a value variable
        if (
          (pkgAlias === "cmp" && (calleeName === "Diff" || calleeName === "Equal")) ||
          (pkgAlias === "reflect" && calleeName === "DeepEqual")
        ) {
          const lhsVars = lhsRaw.split(",").map((s) => s.trim()).filter(Boolean);
          const diffVar = lhsVars[0];
          if (diffVar && diffVar !== "_") {
            for (const [valVar, targets] of valueVarToTargets.entries()) {
              if (new RegExp(`\\b${valVar}\\b`).test(callArgs)) {
                valueVarToTargets.set(diffVar, [
                  ...(valueVarToTargets.get(diffVar) ?? []),
                  ...targets,
                ]);
              }
            }
          }
          continue;
        }

        const targets = resolveGoTarget(calleeName, pkgAlias);
        if (targets.length === 0) continue;

        for (const t of targets) {
          calledTargetsInBlock.set(`${t.fileStem}::${t.name}`, t);
        }

        const lhsVars = lhsRaw.split(",").map((s) => s.trim()).filter(Boolean);
        if (lhsVars.length === 1) {
          const v = lhsVars[0]!;
          if (v !== "_") {
            const errorOnlyTargets = targets.filter((t) => t.returnsErrorOnly);
            const valueTargets = targets.filter((t) => !t.returnsErrorOnly);
            if (errorOnlyTargets.length > 0) {
              valueVarToTargets.set(v, [
                ...(valueVarToTargets.get(v) ?? []),
                ...errorOnlyTargets,
              ]);
            }
            if (valueTargets.length > 0) {
              valueVarToTargets.set(v, [
                ...(valueVarToTargets.get(v) ?? []),
                ...valueTargets,
              ]);
            }
          }
        } else if (lhsVars.length >= 2) {
          for (let i = 0; i < lhsVars.length - 1; i++) {
            const v = lhsVars[i]!;
            if (v !== "_") {
              valueVarToTargets.set(v, [...(valueVarToTargets.get(v) ?? []), ...targets]);
            }
          }
          const lastVar = lhsVars[lhsVars.length - 1]!;
          if (lastVar !== "_") {
            errVarToTargets.set(lastVar, [
              ...(errVarToTargets.get(lastVar) ?? []),
              ...targets,
            ]);
          }
        }
      }

      // 2. Also scan direct calls not in assignments
      const callRe = /(?:([A-Za-z0-9_]+)\.)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
      let cm: RegExpExecArray | null;
      while ((cm = callRe.exec(bodyText)) !== null) {
        const targets = resolveGoTarget(cm[2]!, cm[1]);
        for (const t of targets) {
          calledTargetsInBlock.set(`${t.fileStem}::${t.name}`, t);
        }
      }

      // 3. Scan `if <cond> { ... t.Error/t.Fatal/t.Fail/panic ... }`
      for (const { initPart, condExpr } of extractGoFailureBranchConditions(bodyText)) {
        let inlineVars: Set<string> | null = null;
        if (initPart) {
          const initAssignMatch = /^([A-Za-z0-9_, \t]+?)\s*(?::=|=)/.exec(initPart.trim());
          if (initAssignMatch?.[1]) {
            inlineVars = new Set(
              initAssignMatch[1]
                .split(",")
                .map((s) => s.trim())
                .filter((s) => s && s !== "_"),
            );
          }
        }

        for (const [valVar, targets] of valueVarToTargets.entries()) {
          if (inlineVars && !inlineVars.has(valVar)) continue;
          const varRe = new RegExp(`\\b${valVar}\\b`);
          if (varRe.test(condExpr)) {
            const strippedNilOnly = condExpr
              .replace(new RegExp(`\\b${valVar}\\b\\s*[!=]=\\s*nil\\b`, "g"), "")
              .replace(new RegExp(`\\bnil\\s*[!=]=\\s*\\b${valVar}\\b`, "g"), "")
              .replace(/&&|\|\||\s+/g, "");
            const isNilOnlyCheck = strippedNilOnly.length === 0;
            for (const t of targets) {
              const k = `${t.fileStem}::${t.name}`;
              if (isNilOnlyCheck && !t.returnsErrorOnly) {
                livenessForTarget.set(k, (livenessForTarget.get(k) ?? 0) + 1);
              } else {
                outcomeForTarget.set(k, (outcomeForTarget.get(k) ?? 0) + 1);
              }
            }
          }
        }

        let dcm: RegExpExecArray | null;
        callRe.lastIndex = 0;
        while ((dcm = callRe.exec(condExpr)) !== null) {
          const targets = resolveGoTarget(dcm[2]!, dcm[1]);
          for (const t of targets) {
            const k = `${t.fileStem}::${t.name}`;
            outcomeForTarget.set(k, (outcomeForTarget.get(k) ?? 0) + 1);
          }
        }

        for (const [errVar, targets] of errVarToTargets.entries()) {
          if (inlineVars && !inlineVars.has(errVar)) continue;
          const varRe = new RegExp(`\\b${errVar}\\b`);
          if (varRe.test(condExpr)) {
            for (const t of targets) {
              const k = `${t.fileStem}::${t.name}`;
              livenessForTarget.set(k, (livenessForTarget.get(k) ?? 0) + 1);
            }
          }
        }
      }

      // 4. Scan testify outcome assertions vs liveness checks
      const testifyOutcomeRe =
        /\b(?:assert|require)\.(?:Equal|EqualValues|Exactly|ElementsMatch|True|False|NoError|Error|ErrorIs|Zero)\s*\(([^)]+)\)/g;
      let tm: RegExpExecArray | null;
      while ((tm = testifyOutcomeRe.exec(bodyText)) !== null) {
        const argsText = tm[1]!;
        for (const [valVar, targets] of valueVarToTargets.entries()) {
          if (new RegExp(`\\b${valVar}\\b`).test(argsText)) {
            for (const t of targets) {
              const k = `${t.fileStem}::${t.name}`;
              outcomeForTarget.set(k, (outcomeForTarget.get(k) ?? 0) + 1);
            }
          }
        }
        callRe.lastIndex = 0;
        let dcm: RegExpExecArray | null;
        while ((dcm = callRe.exec(argsText)) !== null) {
          for (const t of resolveGoTarget(dcm[2]!, dcm[1])) {
            const k = `${t.fileStem}::${t.name}`;
            outcomeForTarget.set(k, (outcomeForTarget.get(k) ?? 0) + 1);
          }
        }
      }

      const testifyLivenessRe = /\b(?:assert|require)\.(?:NotNil|NotEmpty)\s*\(([^)]+)\)/g;
      while ((tm = testifyLivenessRe.exec(bodyText)) !== null) {
        const argsText = tm[1]!;
        for (const [valVar, targets] of valueVarToTargets.entries()) {
          if (new RegExp(`\\b${valVar}\\b`).test(argsText)) {
            for (const t of targets) {
              const k = `${t.fileStem}::${t.name}`;
              livenessForTarget.set(k, (livenessForTarget.get(k) ?? 0) + 1);
            }
          }
        }
      }

      for (const [k, target] of calledTargetsInBlock.entries()) {
        const ev = getOrCreateEv(target.fileStem, target.name);
        ev.executedBlocks.add(blockId);
        ev.testFiles.add(toPosix(testRel));
        const oc = outcomeForTarget.get(k) ?? 0;
        const lc = livenessForTarget.get(k) ?? 0;
        if (oc > 0) {
          ev.outcomeAssertedBlocks.add(blockId);
          ev.directOutcomeAssertions += oc;
        } else if (lc > 0) {
          ev.livenessCheckedBlocks.add(blockId);
          ev.directLivenessChecks += lc;
        }
      }
    }
  }

  return {
    evidenceEntries: Array.from(evidenceMap.values()),
    callGraphEdges,
  };
}

const GO_FAILURE_BRANCH_RE =
  /\b(?:panic\s*\(|t\.(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)\b|log\.(?:Fatal|Fatalf|Panic|Panicf)\b|os\.Exit\s*\(\s*[1-9])/;

const GO_EQUALITY_CALL_RE =
  /\b(?:reflect\.DeepEqual|cmp\.(?:Diff|Equal)|bytes\.Equal|slices\.Equal|maps\.Equal|strings\.EqualFold|errors\.(?:Is|As))\s*\(/;

const GO_TESTIFY_OUTCOME_RE =
  /\b(?:assert|require)\.(?:Equal|EqualValues|Exactly|ElementsMatch|True|False|NoError|Error|ErrorIs|Zero)\s*\(([^)]+)\)/g;

function extractGoFailureBranchConditions(
  sourceText: string,
): Array<{ initPart: string; condExpr: string; initMasked: string; condMasked: string }> {
  const { noComments, masked } = stripCommentsAndMaskStrings(sourceText);
  const results: Array<{
    initPart: string;
    condExpr: string;
    initMasked: string;
    condMasked: string;
  }> = [];
  const ifRe = /\bif\b/g;
  let match: RegExpExecArray | null;

  while ((match = ifRe.exec(masked)) !== null) {
    const condStart = match.index + match[0].length;
    let parenDepth = 0;
    let openBraceIdx = -1;
    let closeBraceIdx = -1;

    for (let i = condStart; i < masked.length; i++) {
      const ch = masked[i];
      if (ch === "(") {
        parenDepth++;
      } else if (ch === ")") {
        parenDepth = Math.max(0, parenDepth - 1);
      } else if (ch === "{" && parenDepth === 0) {
        const closeIdx = findMatchingDelimiter(masked, i, "{", "}");
        if (closeIdx === -1) break;
        let k = closeIdx + 1;
        while (k < masked.length && (masked[k] === " " || masked[k] === "\t")) {
          k++;
        }
        const nextCh = masked[k];
        if (
          nextCh === "{" ||
          nextCh === "=" ||
          nextCh === "!" ||
          nextCh === "<" ||
          nextCh === ">" ||
          nextCh === "&" ||
          nextCh === "|"
        ) {
          i = closeIdx;
          continue;
        }
        openBraceIdx = i;
        closeBraceIdx = closeIdx;
        break;
      }
    }

    if (openBraceIdx === -1 || closeBraceIdx === -1) continue;

    const headerRaw = noComments.slice(condStart, openBraceIdx);
    const headerMasked = masked.slice(condStart, openBraceIdx);
    const bodyMasked = masked.slice(openBraceIdx + 1, closeBraceIdx);
    if (GO_FAILURE_BRANCH_RE.test(bodyMasked)) {
      let splitSemi = -1;
      let pDepth = 0;
      let bDepth = 0;
      for (let i = 0; i < headerMasked.length; i++) {
        const c = headerMasked[i];
        if (c === "(") pDepth++;
        else if (c === ")") pDepth = Math.max(0, pDepth - 1);
        else if (c === "{") bDepth++;
        else if (c === "}") bDepth = Math.max(0, bDepth - 1);
        else if (c === ";" && pDepth === 0 && bDepth === 0) {
          splitSemi = i;
          break;
        }
      }
      const initPart = splitSemi !== -1 ? headerRaw.slice(0, splitSemi).trim() : "";
      const condExpr = (splitSemi !== -1 ? headerRaw.slice(splitSemi + 1) : headerRaw).trim();
      const initMasked = splitSemi !== -1 ? headerMasked.slice(0, splitSemi).trim() : "";
      const condMasked = (
        splitSemi !== -1 ? headerMasked.slice(splitSemi + 1) : headerMasked
      ).trim();
      results.push({ initPart, condExpr, initMasked, condMasked });
    }
  }

  return results;
}

/**
 * Counts Go Outcome Assertions in a standalone code snippet or test body,
 * reusing the Go adapter's value-comparison / `reflect.DeepEqual` / `cmp.Diff` / `testify`
 * rules and excluding `fmt.Println` or pure `err != nil` checks.
 */
export function countGoOutcomeAssertions(sourceText: string): number {
  const { masked } = stripCommentsAndMaskStrings(sourceText);
  let count = 0;

  const equalityVars = new Set<string>();
  const eqAssignRe =
    /([A-Za-z_][A-Za-z0-9_]*)\s*(?::=|=)\s*(?:reflect\.DeepEqual|cmp\.(?:Diff|Equal)|bytes\.Equal|slices\.Equal|maps\.Equal|strings\.EqualFold|errors\.(?:Is|As))\s*\(/g;
  let em: RegExpExecArray | null;
  while ((em = eqAssignRe.exec(masked)) !== null) {
    if (em[1] && em[1] !== "_") {
      equalityVars.add(em[1]);
    }
  }

  for (const { initMasked, condMasked } of extractGoFailureBranchConditions(sourceText)) {
    if (!condMasked) continue;

    if (GO_EQUALITY_CALL_RE.test(condMasked) || GO_EQUALITY_CALL_RE.test(initMasked)) {
      count++;
      continue;
    }

    let usesEqualityVar = false;
    for (const eqVar of equalityVars) {
      if (new RegExp(`\\b${eqVar}\\b`).test(condMasked)) {
        usesEqualityVar = true;
        break;
      }
    }
    if (usesEqualityVar) {
      count++;
      continue;
    }

    const strippedNil = condMasked
      .replace(/\b[A-Za-z_][A-Za-z0-9_.]*\s*[!=]=\s*nil\b/g, "")
      .replace(/\bnil\s*[!=]=\s*[A-Za-z_][A-Za-z0-9_.]*\b/g, "")
      .replace(/&&|\|\||\s+/g, "");

    if (strippedNil.length === 0) {
      continue;
    }

    if (/(?:==|!=|<=|>=|<|>|!)/.test(strippedNil)) {
      count++;
    }
  }

  GO_TESTIFY_OUTCOME_RE.lastIndex = 0;
  let tm: RegExpExecArray | null;
  while ((tm = GO_TESTIFY_OUTCOME_RE.exec(masked)) !== null) {
    count++;
  }

  return count;
}

// ============================================================================
// Rust LanguageAdapter
// ============================================================================

export function findRustInlineTestByteRanges(
  masked: string,
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const attrRe = /#\s*\[\s*(?:cfg\s*\(\s*test\s*\)|(?:\w+::)*test)\s*\]/g;
  let m: RegExpExecArray | null;

  while ((m = attrRe.exec(masked)) !== null) {
    const startIdx = m.index;
    const openBraceIdx = masked.indexOf("{", m.index + m[0].length);
    if (openBraceIdx === -1) continue;
    const closeBraceIdx = findMatchingDelimiter(masked, openBraceIdx, "{", "}");
    if (closeBraceIdx === -1) continue;
    ranges.push({ start: startIdx, end: closeBraceIdx + 1 });
    attrRe.lastIndex = closeBraceIdx + 1;
  }

  return ranges;
}

export function extractRustInlineTestFingerprint(sourceText: string): string {
  const { noComments, masked } = stripCommentsAndMaskStrings(sourceText);
  const ranges = findRustInlineTestByteRanges(masked);
  if (ranges.length === 0) return "";
  return ranges
    .map((r) => noComments.slice(r.start, r.end).replace(/\s+/g, " ").trim())
    .join("||");
}

function parseAllRustFunctions(
  sourceText: string,
): Array<PolyglotFunctionSpan & { isTest: boolean; startOffset: number; endOffset: number }> {
  const { noComments, masked } = stripCommentsAndMaskStrings(sourceText);
  const lineStarts = buildLineStarts(sourceText);
  const inlineTestRanges = findRustInlineTestByteRanges(masked);
  const fnRegex = /\bfn\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  const results: Array<
    PolyglotFunctionSpan & { isTest: boolean; startOffset: number; endOffset: number }
  > = [];

  let match: RegExpExecArray | null;
  while ((match = fnRegex.exec(masked)) !== null) {
    const fnStartIdx = match.index;
    const fnName = match[1]!;
    let cursor = fnStartIdx + match[0].length;

    while (cursor < masked.length && /\s/.test(masked[cursor]!)) cursor++;
    if (masked[cursor] === "<") {
      const closeGen = findMatchingDelimiter(masked, cursor, "<", ">");
      if (closeGen === -1) continue;
      cursor = closeGen + 1;
    }

    while (cursor < masked.length && /\s/.test(masked[cursor]!)) cursor++;
    if (masked[cursor] !== "(") continue;
    const closeParams = findMatchingDelimiter(masked, cursor, "(", ")");
    if (closeParams === -1) continue;
    cursor = closeParams + 1;

    const openBraceIdx = masked.indexOf("{", cursor);
    const semiIdx = masked.indexOf(";", cursor);
    if (openBraceIdx === -1 || (semiIdx !== -1 && semiIdx < openBraceIdx)) {
      continue;
    }

    const closeBraceIdx = findMatchingDelimiter(masked, openBraceIdx, "{", "}");
    if (closeBraceIdx === -1) continue;

    const headerSlice = noComments.slice(cursor, openBraceIdx).trim();
    const arrowIdx = headerSlice.indexOf("->");
    const returnSignature =
      arrowIdx !== -1
        ? headerSlice
            .slice(arrowIdx + 2)
            .replace(/\bwhere\b[\s\S]*$/, "")
            .trim()
        : "";

    const insideTestRange = inlineTestRanges.some(
      (r) => fnStartIdx >= r.start && closeBraceIdx <= r.end,
    );
    const startLine = offsetToLine(lineStarts, fnStartIdx);
    const endLine = offsetToLine(lineStarts, closeBraceIdx);
    const bodyMasked = masked.slice(openBraceIdx, closeBraceIdx + 1);
    const runtimeSlice = noComments
      .slice(fnStartIdx, closeBraceIdx + 1)
      .replace(/\s+/g, " ")
      .trim();

    results.push({
      name: fnName,
      startLine,
      endLine,
      cyclomaticComplexity: countComplexityInMaskedSlice(bodyMasked, "rust"),
      returnSignature,
      runtimeFingerprint: `${fnName}:${runtimeSlice}`,
      isTest: insideTestRange,
      startOffset: fnStartIdx,
      endOffset: closeBraceIdx + 1,
    });

    fnRegex.lastIndex = closeBraceIdx + 1;
  }

  return results;
}

export function extractRustFunctionSpans(sourceText: string): PolyglotFunctionSpan[] {
  return parseAllRustFunctions(sourceText)
    .filter((f) => !f.isTest)
    .map(({ isTest: _t, startOffset: _s, endOffset: _e, ...rest }) => rest);
}

export function extractRustSymbols(
  sourceText: string,
  filePath: string,
): PolyglotExtractedSymbol[] {
  const relPath = filePath.replace(/\\/g, "/");
  const { noComments, masked } = stripCommentsAndMaskStrings(sourceText);
  const lineStarts = buildLineStarts(sourceText);
  const inlineTestRanges = findRustInlineTestByteRanges(masked);
  const isInTest = (offset: number): boolean =>
    inlineTestRanges.some((r) => offset >= r.start && offset < r.end);

  const baseName = path.posix.basename(relPath, ".rs");
  const modStem = baseName !== "lib" && baseName !== "main" && baseName !== "mod" ? baseName : undefined;

  const implRanges: Array<{ typeName: string; start: number; end: number }> = [];
  const implRe =
    /\bimpl(?:\s*<[^>]*>)?\s+(?:[A-Za-z_][A-Za-z0-9_:<>]*\s+for\s+)?([A-Za-z_][A-Za-z0-9_]*)/g;
  let im: RegExpExecArray | null;
  while ((im = implRe.exec(masked)) !== null) {
    if (isInTest(im.index)) continue;
    const openBraceIdx = masked.indexOf("{", im.index + im[0].length);
    if (openBraceIdx === -1) continue;
    const closeBraceIdx = findMatchingDelimiter(masked, openBraceIdx, "{", "}");
    if (closeBraceIdx === -1) continue;
    implRanges.push({
      typeName: im[1]!,
      start: openBraceIdx,
      end: closeBraceIdx + 1,
    });
  }

  const symbols: PolyglotExtractedSymbol[] = [];
  for (const fn of parseAllRustFunctions(sourceText)) {
    if (fn.isTest) continue;
    const enclosingImpl = implRanges.find(
      (r) => fn.startOffset >= r.start && fn.endOffset <= r.end,
    );
    const qualifiedName = enclosingImpl
      ? `${enclosingImpl.typeName}::${fn.name}`
      : modStem
        ? `${modStem}::${fn.name}`
        : undefined;
    symbols.push({
      name: fn.name,
      ...(qualifiedName ? { qualifiedName } : {}),
      kind: enclosingImpl ? "method" : "function",
      file: relPath,
      startLine: fn.startLine,
      endLine: fn.endLine,
      runtimeFingerprint: fn.runtimeFingerprint,
    });
  }

  const typeRe =
    /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+([A-Za-z_][A-Za-z0-9_]*)\b/gm;
  let tm: RegExpExecArray | null;
  while ((tm = typeRe.exec(masked)) !== null) {
    if (isInTest(tm.index)) continue;
    const typeName = tm[1]!;
    const declStart = tm.index;
    const afterName = declStart + tm[0].length;
    const nextBrace = masked.indexOf("{", afterName);
    const nextSemi = masked.indexOf(";", afterName);
    let endOffset: number;
    if (nextBrace !== -1 && (nextSemi === -1 || nextBrace < nextSemi)) {
      const closeBrace = findMatchingDelimiter(masked, nextBrace, "{", "}");
      endOffset = closeBrace !== -1 ? closeBrace + 1 : nextBrace + 1;
    } else if (nextSemi !== -1) {
      endOffset = nextSemi + 1;
    } else {
      const lineEnd = masked.indexOf("\n", declStart);
      endOffset = lineEnd === -1 ? masked.length : lineEnd;
    }

    const startLine = offsetToLine(lineStarts, declStart);
    const endLine = offsetToLine(lineStarts, Math.max(declStart, endOffset - 1));
    const bodyFp = noComments
      .slice(declStart, endOffset)
      .replace(/\s+/g, " ")
      .trim();
    symbols.push({
      name: typeName,
      ...(modStem ? { qualifiedName: `${modStem}::${typeName}` } : {}),
      kind: "class",
      file: relPath,
      startLine,
      endLine,
      runtimeFingerprint: `class:${typeName}:${bodyFp}`,
    });
  }

  return symbols.sort((a, b) => a.startLine - b.startLine);
}

export function buildRustZeroReturnBody(returnSignature: string): string {
  const sig = returnSignature.trim();
  if (!sig || sig === "()") return "{}";
  if (sig === "bool") return "{ false }";
  if (sig === "String") return "{ String::new() }";
  if (sig === "&str" || sig === "&'static str") return '{ "" }';
  if (/^(?:[iu](?:8|16|32|64|128|size)|f(?:32|64))$/.test(sig)) {
    return `{ 0 as ${sig} }`;
  }
  if (sig.startsWith("Option<")) return "{ None }";
  if (sig.startsWith("Vec<")) return "{ Vec::new() }";
  if (sig.startsWith("Result<")) {
    const inner = sig.slice("Result<".length, -1);
    const commaIdx = inner.indexOf(",");
    const okType = (commaIdx !== -1 ? inner.slice(0, commaIdx) : inner).trim();
    const okBody = buildRustZeroReturnBody(okType)
      .replace(/^\{\s*/, "")
      .replace(/\s*\}$/, "");
    return `{ Ok(${okBody || "Default::default()"}) }`;
  }
  return "{ Default::default() }";
}

export function generateRustCandidateMutations(
  sourceText: string,
  startLine?: number,
  endLine?: number,
): PolyglotCandidateMutation[] {
  const { noComments, masked } = stripCommentsAndMaskStrings(sourceText);
  const inlineTestRanges = findRustInlineTestByteRanges(masked);
  const prodFns = parseAllRustFunctions(sourceText).filter((f) => !f.isTest);
  const candidates: PolyglotCandidateMutation[] = [];
  let seq = 1;

  function isOffsetInInlineTest(offset: number): boolean {
    return inlineTestRanges.some((r) => offset >= r.start && offset < r.end);
  }

  function addMutation(
    startOffset: number,
    endOffset: number,
    replacement: string,
    line: number,
    isBodyClearance = false,
  ): void {
    const original = sourceText.slice(startOffset, endOffset);
    if (original === replacement) return;
    candidates.push({
      id: `mut_${seq++}`,
      line,
      original,
      mutated: replacement,
      mutatedSource:
        sourceText.slice(0, startOffset) + replacement + sourceText.slice(endOffset),
      isBodyClearance,
    });
  }

  for (const fn of prodFns) {
    const overlapsRange =
      (startLine === undefined || fn.endLine >= startLine) &&
      (endLine === undefined || fn.startLine <= endLine);
    if (!overlapsRange) continue;
    const openBraceIdx = masked.indexOf("{", fn.startOffset);
    if (openBraceIdx === -1 || openBraceIdx >= fn.endOffset) continue;
    const zeroBody = buildRustZeroReturnBody(fn.returnSignature);
    addMutation(openBraceIdx, fn.endOffset, zeroBody, fn.startLine, true);
  }

  collectOperatorMutations({
    sourceText,
    noComments,
    startLine,
    endLine,
    skipOffset: isOffsetInInlineTest,
    addMutation: (s, e, rep, ln) => addMutation(s, e, rep, ln, false),
  });

  return candidates;
}

export interface RustAssertionSpan {
  kind: "outcome" | "liveness";
  expr: string;
}

export function extractRustAssertionSpans(noCommentsText: string): RustAssertionSpan[] {
  const spans: RustAssertionSpan[] = [];
  const coveredRanges: Array<{ start: number; end: number }> = [];
  const closeForOpen: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

  const macroRe =
    /\b(assert_eq|assert_ne|debug_assert_eq|debug_assert_ne|assert_matches|debug_assert_matches|assert|debug_assert)!\s*([([{])/g;
  let m: RegExpExecArray | null;
  while ((m = macroRe.exec(noCommentsText)) !== null) {
    const macroName = m[1]!;
    const openChar = m[2]!;
    const closeChar = closeForOpen[openChar] ?? ")";
    const openIdx = m.index + m[0].length - 1;
    const closeIdx = findMatchingDelimiter(noCommentsText, openIdx, openChar, closeChar);
    if (closeIdx === -1) continue;
    const expr = noCommentsText.slice(openIdx + 1, closeIdx);
    coveredRanges.push({ start: m.index, end: closeIdx + 1 });

    if (macroName === "assert" || macroName === "debug_assert") {
      const isPureLiveness =
        /\.\s*(?:is_ok|is_some)\s*\(\s*\)/.test(expr) &&
        !/==|!=|<=|>=|<|>|\bmatches!\b/.test(expr);
      spans.push({
        kind: isPureLiveness ? "liveness" : "outcome",
        expr,
      });
    } else {
      spans.push({
        kind: "outcome",
        expr,
      });
    }
  }

  // Standalone `matches!(...)` outside an outer `assert!(...)` macro
  const matchesMacroRe = /\bmatches!\s*([([{])/g;
  while ((m = matchesMacroRe.exec(noCommentsText)) !== null) {
    const startIdx = m.index;
    if (coveredRanges.some((r) => startIdx >= r.start && startIdx < r.end)) {
      continue;
    }
    const openChar = m[1]!;
    const closeChar = closeForOpen[openChar] ?? ")";
    const openIdx = startIdx + m[0].length - 1;
    const closeIdx = findMatchingDelimiter(noCommentsText, openIdx, openChar, closeChar);
    if (closeIdx === -1) continue;
    const expr = noCommentsText.slice(openIdx + 1, closeIdx);
    spans.push({
      kind: "outcome",
      expr,
    });
  }

  return spans;
}

/**
 * Counts Rust Outcome Assertions (`assert_eq!`, `assert_ne!`, `matches!`, non-liveness `assert!`)
 * in a standalone Rust code snippet, reusing the Rust adapter's assertion classification.
 * `.unwrap()`, `.expect()`, `assert!(x.is_ok())`, and `println!` are not counted as Outcome Assertions.
 */
export function countRustOutcomeAssertions(sourceText: string): number {
  const { noComments } = stripCommentsAndMaskStrings(sourceText);
  return extractRustAssertionSpans(noComments).filter((s) => s.kind === "outcome").length;
}

export function hasRustMainFunction(sourceText: string): boolean {
  const { masked } = stripCommentsAndMaskStrings(sourceText);
  return /\bfn\s+main\s*\(/.test(masked);
}

export interface RustFunctionAstMeta {
  name: string;
  fileStem: string;
  calledSymbols: string[];
}

export async function analyzeRustFilesAstEvidence(
  rootDir: string,
  rustSourceFiles: string[],
  rustTestFiles: string[],
): Promise<PolyglotRepoAstEvidence> {
  const toPosix = (p: string) => p.replace(/\\/g, "/");
  const stripExt = (p: string) => p.replace(/\.rs$/, "");

  const rustFunctionsByKey = new Map<string, RustFunctionAstMeta>();
  const rustFunctionsByStemAndName = new Map<string, RustFunctionAstMeta>();
  const rustFunctionsByName = new Map<string, RustFunctionAstMeta[]>();
  const callGraphEdges = new Map<string, Set<string>>();

  const allRustFiles = Array.from(new Set([...rustSourceFiles, ...rustTestFiles]));
  const parsedByFile = new Map<
    string,
    {
      content: string;
      noComments: string;
      fns: Array<
        PolyglotFunctionSpan & { isTest: boolean; startOffset: number; endOffset: number }
      >;
    }
  >();

  const RUST_IGNORE_CALLEES = new Set([
    "if",
    "for",
    "while",
    "match",
    "return",
    "Some",
    "None",
    "Ok",
    "Err",
    "vec",
    "format",
    "println",
    "eprintln",
    "panic",
    "unwrap",
    "expect",
    "is_ok",
    "is_err",
    "is_some",
    "is_none",
    "new",
    "len",
    "is_empty",
    "clone",
    "into",
    "from",
  ]);

  for (const rel of allRustFiles) {
    const fullPath = path.join(rootDir, rel);
    let content = "";
    try {
      content = await fs.readFile(fullPath, "utf8");
    } catch {
      continue;
    }
    const { noComments } = stripCommentsAndMaskStrings(content);
    const fns = parseAllRustFunctions(content);
    parsedByFile.set(rel, { content, noComments, fns });

    if (rustSourceFiles.includes(rel)) {
      const fileStem = stripExt(toPosix(rel));
      const lines = noComments.split("\n");
      for (const fn of fns) {
        if (fn.isTest) continue;
        const bodyText = lines.slice(fn.startLine - 1, fn.endLine).join("\n");
        const calledSymbols: string[] = [];
        const callRe = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
        let cm: RegExpExecArray | null;
        while ((cm = callRe.exec(bodyText)) !== null) {
          const callee = cm[1]!;
          if (callee !== fn.name && !RUST_IGNORE_CALLEES.has(callee)) {
            calledSymbols.push(callee);
          }
        }
        const meta: RustFunctionAstMeta = {
          name: fn.name,
          fileStem,
          calledSymbols,
        };
        const key = `${fileStem}::${fn.name}`;
        rustFunctionsByKey.set(key, meta);
        rustFunctionsByStemAndName.set(key, meta);
        const list = rustFunctionsByName.get(fn.name) ?? [];
        list.push(meta);
        rustFunctionsByName.set(fn.name, list);
      }
    }
  }

  for (const [callerKey, meta] of rustFunctionsByKey.entries()) {
    const edges = new Set<string>();
    for (const calleeName of meta.calledSymbols) {
      const sameFile = rustFunctionsByStemAndName.get(`${meta.fileStem}::${calleeName}`);
      const targets = sameFile ? [sameFile] : (rustFunctionsByName.get(calleeName) ?? []);
      for (const t of targets) {
        edges.add(`${t.fileStem}::${t.name}`);
      }
    }
    callGraphEdges.set(callerKey, edges);
  }

  const { evidenceMap, getOrCreateEv } = createEvidenceAccumulator();

  for (const [rel, parsed] of parsedByFile.entries()) {
    const fileStem = stripExt(toPosix(rel));
    const lines = parsed.noComments.split("\n");
    const isDedicatedTestFile = rustTestFiles.includes(rel);
    let blockCounter = 0;

    function resolveRustTarget(calleeName: string): RustFunctionAstMeta[] {
      const sameFile = rustFunctionsByStemAndName.get(`${fileStem}::${calleeName}`);
      if (sameFile) return [sameFile];
      return rustFunctionsByName.get(calleeName) ?? [];
    }

    for (const fn of parsed.fns) {
      if (!fn.isTest && !isDedicatedTestFile) continue;
      const blockId = `${toPosix(rel)}#${++blockCounter}`;
      const bodyText = lines.slice(fn.startLine - 1, fn.endLine).join("\n");

      const varToTargets = new Map<string, RustFunctionAstMeta[]>();
      const calledTargetsInBlock = new Map<string, RustFunctionAstMeta>();
      const outcomeForTarget = new Map<string, number>();
      const livenessForTarget = new Map<string, number>();

      // 1. Track `let [mut] <var> = ... <callee>(...)`
      const letRe =
        /\blet\s+(?:mut\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]+)?=\s*([^;]+);/g;
      let lm: RegExpExecArray | null;
      while ((lm = letRe.exec(bodyText)) !== null) {
        const varName = lm[1]!;
        const rhs = lm[2]!;
        const callRe = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
        let cm: RegExpExecArray | null;
        const rhsTargets: RustFunctionAstMeta[] = [];
        while ((cm = callRe.exec(rhs)) !== null) {
          const targets = resolveRustTarget(cm[1]!);
          for (const t of targets) {
            calledTargetsInBlock.set(`${t.fileStem}::${t.name}`, t);
            rhsTargets.push(t);
          }
        }
        if (varName !== "_" && rhsTargets.length > 0) {
          varToTargets.set(varName, rhsTargets);
          if (/\.\s*(?:unwrap|expect)\s*\(/.test(rhs)) {
            for (const t of rhsTargets) {
              const k = `${t.fileStem}::${t.name}`;
              livenessForTarget.set(k, (livenessForTarget.get(k) ?? 0) + 1);
            }
          }
        } else if (
          varName === "_" &&
          rhsTargets.length > 0 &&
          /\.\s*(?:unwrap|expect)\s*\(/.test(rhs)
        ) {
          for (const t of rhsTargets) {
            const k = `${t.fileStem}::${t.name}`;
            livenessForTarget.set(k, (livenessForTarget.get(k) ?? 0) + 1);
          }
        }
      }

      // 2. Track all calls in test body
      const callRe = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
      let cm: RegExpExecArray | null;
      while ((cm = callRe.exec(bodyText)) !== null) {
        const callee = cm[1]!;
        for (const t of resolveRustTarget(callee)) {
          calledTargetsInBlock.set(`${t.fileStem}::${t.name}`, t);
        }
      }

      function collectTargetsInExpr(expr: string): RustFunctionAstMeta[] {
        const found: RustFunctionAstMeta[] = [];
        for (const [vName, targets] of varToTargets.entries()) {
          if (new RegExp(`\\b${vName}\\b`).test(expr)) {
            found.push(...targets);
          }
        }
        const exprCallRe = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
        let ecm: RegExpExecArray | null;
        while ((ecm = exprCallRe.exec(expr)) !== null) {
          found.push(...resolveRustTarget(ecm[1]!));
        }
        return found;
      }

      // 3. Outcome & Liveness assertions (`assert_eq!`, `assert_ne!`, `assert_matches!`, `matches!`, `assert!`)
      for (const span of extractRustAssertionSpans(bodyText)) {
        const targets = collectTargetsInExpr(span.expr);
        for (const t of targets) {
          const k = `${t.fileStem}::${t.name}`;
          if (span.kind === "outcome") {
            outcomeForTarget.set(k, (outcomeForTarget.get(k) ?? 0) + 1);
          } else {
            livenessForTarget.set(k, (livenessForTarget.get(k) ?? 0) + 1);
          }
        }
      }

      for (const [k, target] of calledTargetsInBlock.entries()) {
        const ev = getOrCreateEv(target.fileStem, target.name);
        ev.executedBlocks.add(blockId);
        ev.testFiles.add(toPosix(rel));
        const oc = outcomeForTarget.get(k) ?? 0;
        const lc = livenessForTarget.get(k) ?? 0;
        if (oc > 0) {
          ev.outcomeAssertedBlocks.add(blockId);
          ev.directOutcomeAssertions += oc;
        } else if (lc > 0) {
          ev.livenessCheckedBlocks.add(blockId);
          ev.directLivenessChecks += lc;
        }
      }
    }
  }

  return {
    evidenceEntries: Array.from(evidenceMap.values()),
    callGraphEdges,
  };
}

// ============================================================================
// Java LanguageAdapter
// ============================================================================

const JAVA_KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "synchronized",
  "return",
  "new",
  "throw",
  "super",
  "this",
  "class",
  "interface",
  "enum",
  "record",
]);

export function extractJavaFunctionSpans(sourceText: string): PolyglotFunctionSpan[] {
  const { noComments, masked } = stripCommentsAndMaskStrings(sourceText);
  const lineStarts = buildLineStarts(sourceText);
  const spans: PolyglotFunctionSpan[] = [];

  const methodRegex =
    /^[ \t]*(?:@[A-Za-z0-9_$.]+(?:\([^)]*\))?\s+)*(?:(?:public|protected|private|static|final|synchronized|abstract|default|native|strictfp)\s+)*(?:<[^{;]+>\s+)?([A-Za-z_][A-Za-z0-9_<>,.?[\]\s]*?)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm;

  let match: RegExpExecArray | null;
  while ((match = methodRegex.exec(masked)) !== null) {
    const rawReturnType = match[1]!.trim();
    const methodName = match[2]!;
    if (
      JAVA_KEYWORDS.has(methodName) ||
      JAVA_KEYWORDS.has(rawReturnType) ||
      /\b(?:class|interface|enum|record)\b/.test(rawReturnType)
    ) {
      continue;
    }

    const declStartIdx = match.index;
    const openParenIdx = declStartIdx + match[0].length - 1;
    const closeParenIdx = findMatchingDelimiter(masked, openParenIdx, "(", ")");
    if (closeParenIdx === -1) continue;

    const cursor = closeParenIdx + 1;
    const openBraceIdx = masked.indexOf("{", cursor);
    const semiIdx = masked.indexOf(";", cursor);
    if (openBraceIdx === -1 || (semiIdx !== -1 && semiIdx < openBraceIdx)) {
      continue;
    }

    const closeBraceIdx = findMatchingDelimiter(masked, openBraceIdx, "{", "}");
    if (closeBraceIdx === -1) continue;

    const retStartInMatch = match[0].indexOf(match[1]!);
    const returnSignature = noComments
      .slice(declStartIdx + retStartInMatch, declStartIdx + retStartInMatch + match[1]!.length)
      .trim();

    const startLine = offsetToLine(lineStarts, declStartIdx);
    const endLine = offsetToLine(lineStarts, closeBraceIdx);
    const bodyMasked = masked.slice(openBraceIdx, closeBraceIdx + 1);
    const runtimeSlice = noComments
      .slice(declStartIdx, closeBraceIdx + 1)
      .replace(/\s+/g, " ")
      .trim();

    spans.push({
      name: methodName,
      startLine,
      endLine,
      cyclomaticComplexity: countComplexityInMaskedSlice(bodyMasked, "java"),
      returnSignature,
      runtimeFingerprint: `${methodName}:${runtimeSlice}`,
    });

    methodRegex.lastIndex = closeBraceIdx + 1;
  }

  return spans;
}

export function extractJavaSymbols(
  sourceText: string,
  filePath: string,
): PolyglotExtractedSymbol[] {
  const relPath = filePath.replace(/\\/g, "/");
  const { noComments, masked } = stripCommentsAndMaskStrings(sourceText);
  const lineStarts = buildLineStarts(sourceText);

  const symbols: PolyglotExtractedSymbol[] = [];
  const classRanges: Array<{ typeName: string; startLine: number; endLine: number }> = [];

  const typeRe =
    /^[ \t]*(?:@[A-Za-z0-9_$.]+(?:\([^)]*\))?\s+)*(?:(?:public|protected|private|abstract|final|static|strictfp)\s+)*(?:class|enum|record|interface)\s+([A-Za-z_][A-Za-z0-9_]*)\b/gm;
  let tm: RegExpExecArray | null;
  while ((tm = typeRe.exec(masked)) !== null) {
    const typeName = tm[1]!;
    const declStart = tm.index;
    const openBraceIdx = masked.indexOf("{", declStart + tm[0].length);
    let endOffset: number;
    if (openBraceIdx !== -1) {
      const closeBraceIdx = findMatchingDelimiter(masked, openBraceIdx, "{", "}");
      endOffset = closeBraceIdx !== -1 ? closeBraceIdx + 1 : openBraceIdx + 1;
    } else {
      const lineEnd = masked.indexOf("\n", declStart);
      endOffset = lineEnd === -1 ? masked.length : lineEnd;
    }

    const startLine = offsetToLine(lineStarts, declStart);
    const endLine = offsetToLine(lineStarts, Math.max(declStart, endOffset - 1));
    const bodyFp = noComments
      .slice(declStart, endOffset)
      .replace(/\s+/g, " ")
      .trim();
    classRanges.push({ typeName, startLine, endLine });
    symbols.push({
      name: typeName,
      kind: "class",
      file: relPath,
      startLine,
      endLine,
      runtimeFingerprint: `class:${typeName}:${bodyFp}`,
    });
  }

  const fallbackClassName = path.posix.basename(relPath, ".java");
  for (const span of extractJavaFunctionSpans(sourceText)) {
    const enclosing =
      classRanges
        .filter((c) => span.startLine >= c.startLine && span.endLine <= c.endLine)
        .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0]?.typeName ??
      fallbackClassName;
    symbols.push({
      name: span.name,
      ...(enclosing ? { qualifiedName: `${enclosing}.${span.name}` } : {}),
      kind: "method",
      file: relPath,
      startLine: span.startLine,
      endLine: span.endLine,
      runtimeFingerprint: span.runtimeFingerprint,
    });
  }

  return symbols.sort((a, b) => a.startLine - b.startLine);
}

export function buildJavaZeroReturnBody(returnSignature: string): string {
  const sig = returnSignature.trim();
  if (!sig || sig === "void") return "{ return; }";
  if (sig === "boolean") return "{ return false; }";
  if (sig === "byte" || sig === "short" || sig === "int") return "{ return 0; }";
  if (sig === "long") return "{ return 0L; }";
  if (sig === "float") return "{ return 0.0f; }";
  if (sig === "double") return "{ return 0.0d; }";
  if (sig === "char") return "{ return '\\0'; }";
  return "{ return null; }";
}

export function generateJavaCandidateMutations(
  sourceText: string,
  startLine?: number,
  endLine?: number,
): PolyglotCandidateMutation[] {
  const { noComments, masked } = stripCommentsAndMaskStrings(sourceText);
  const lineStarts = buildLineStarts(sourceText);
  const spans = extractJavaFunctionSpans(sourceText);
  const candidates: PolyglotCandidateMutation[] = [];
  let seq = 1;

  function addMutation(
    startOffset: number,
    endOffset: number,
    replacement: string,
    line: number,
    isBodyClearance = false,
  ): void {
    const original = sourceText.slice(startOffset, endOffset);
    if (original === replacement) return;
    candidates.push({
      id: `mut_${seq++}`,
      line,
      original,
      mutated: replacement,
      mutatedSource:
        sourceText.slice(0, startOffset) + replacement + sourceText.slice(endOffset),
      isBodyClearance,
    });
  }

  for (const span of spans) {
    const overlapsRange =
      (startLine === undefined || span.endLine >= startLine) &&
      (endLine === undefined || span.startLine <= endLine);
    if (!overlapsRange) continue;

    const spanStartOffset = lineStarts[span.startLine - 1] ?? 0;
    const openBraceIdx = masked.indexOf("{", spanStartOffset);
    if (openBraceIdx === -1) continue;
    const closeBraceIdx = findMatchingDelimiter(masked, openBraceIdx, "{", "}");
    if (closeBraceIdx === -1) continue;

    const zeroBody = buildJavaZeroReturnBody(span.returnSignature);
    addMutation(openBraceIdx, closeBraceIdx + 1, zeroBody, span.startLine, true);
  }

  collectOperatorMutations({
    sourceText,
    noComments,
    startLine,
    endLine,
    addMutation: (s, e, rep, ln) => addMutation(s, e, rep, ln, false),
  });

  return candidates;
}

export interface JavaMethodAstMeta {
  name: string;
  fileStem: string;
  packageName: string;
  className: string;
  calledSymbols: string[];
}

function parseJavaPackageAndImports(content: string): {
  packageName: string;
  importedClasses: Set<string>;
} {
  const pkgMatch = /^\s*package\s+([A-Za-z0-9_.]+)\s*;/m.exec(content);
  const packageName = pkgMatch?.[1] ?? "";
  const importedClasses = new Set<string>();
  const impRe = /^\s*import\s+(?:static\s+)?([A-Za-z0-9_.*]+)\s*;/gm;
  let im: RegExpExecArray | null;
  while ((im = impRe.exec(content)) !== null) {
    const segs = im[1]!.split(".");
    const last = segs[segs.length - 1];
    if (last && last !== "*") {
      importedClasses.add(last);
    }
  }
  return { packageName, importedClasses };
}

export async function analyzeJavaFilesAstEvidence(
  rootDir: string,
  javaSourceFiles: string[],
  javaTestFiles: string[],
): Promise<PolyglotRepoAstEvidence> {
  const toPosix = (p: string) => p.replace(/\\/g, "/");
  const stripExt = (p: string) => p.replace(/\.java$/, "");

  const javaMethodsByKey = new Map<string, JavaMethodAstMeta>();
  const javaMethodsByClassAndName = new Map<string, JavaMethodAstMeta[]>();
  const javaMethodsByPkgAndName = new Map<string, JavaMethodAstMeta[]>();
  const javaMethodsByName = new Map<string, JavaMethodAstMeta[]>();
  const callGraphEdges = new Map<string, Set<string>>();

  const JAVA_IGNORE_CALLEES = new Set([
    ...JAVA_KEYWORDS,
    "assertEquals",
    "assertNotEquals",
    "assertArrayEquals",
    "assertIterableEquals",
    "assertLinesMatch",
    "assertThrows",
    "assertThrowsExactly",
    "assertSame",
    "assertNotSame",
    "assertNotNull",
    "assertNull",
    "assertTrue",
    "assertFalse",
    "assertDoesNotThrow",
    "assertThat",
    "assertThatThrownBy",
    "isEqualTo",
    "isNotEqualTo",
    "contains",
    "containsExactly",
    "hasSize",
    "isNotNull",
    "isNull",
    "isPresent",
    "isTrue",
    "isFalse",
    "when",
    "given",
    "println",
    "format",
    "valueOf",
    "toString",
    "equals",
    "hashCode",
  ]);

  for (const srcRel of javaSourceFiles) {
    const fullPath = path.join(rootDir, srcRel);
    let content = "";
    try {
      content = await fs.readFile(fullPath, "utf8");
    } catch {
      continue;
    }
    const { packageName } = parseJavaPackageAndImports(content);
    const spans = extractJavaFunctionSpans(content);
    const { noComments } = stripCommentsAndMaskStrings(content);
    const lines = noComments.split("\n");
    const fileStem = stripExt(toPosix(srcRel));
    const className = path.basename(srcRel, ".java");

    for (const span of spans) {
      const bodyText = lines.slice(span.startLine - 1, span.endLine).join("\n");
      const calledSymbols: string[] = [];
      const callRe = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
      let cm: RegExpExecArray | null;
      while ((cm = callRe.exec(bodyText)) !== null) {
        const callee = cm[1]!;
        if (callee !== span.name && callee !== className && !JAVA_IGNORE_CALLEES.has(callee)) {
          calledSymbols.push(callee);
        }
      }

      const meta: JavaMethodAstMeta = {
        name: span.name,
        fileStem,
        packageName,
        className,
        calledSymbols,
      };
      const key = `${fileStem}::${span.name}`;
      javaMethodsByKey.set(key, meta);

      const clsKey = `${className}::${span.name}`;
      const clsList = javaMethodsByClassAndName.get(clsKey) ?? [];
      clsList.push(meta);
      javaMethodsByClassAndName.set(clsKey, clsList);

      const pkgKey = `${packageName}::${span.name}`;
      const pkgList = javaMethodsByPkgAndName.get(pkgKey) ?? [];
      pkgList.push(meta);
      javaMethodsByPkgAndName.set(pkgKey, pkgList);

      const nameList = javaMethodsByName.get(span.name) ?? [];
      nameList.push(meta);
      javaMethodsByName.set(span.name, nameList);
    }
  }

  for (const [callerKey, meta] of javaMethodsByKey.entries()) {
    const edges = new Set<string>();
    for (const calleeName of meta.calledSymbols) {
      const sameCls = javaMethodsByClassAndName.get(`${meta.className}::${calleeName}`);
      const samePkg = javaMethodsByPkgAndName.get(`${meta.packageName}::${calleeName}`);
      const targets = sameCls ?? samePkg ?? javaMethodsByName.get(calleeName) ?? [];
      for (const t of targets) {
        edges.add(`${t.fileStem}::${t.name}`);
      }
    }
    callGraphEdges.set(callerKey, edges);
  }

  const { evidenceMap, getOrCreateEv } = createEvidenceAccumulator();

  for (const testRel of javaTestFiles) {
    const fullPath = path.join(rootDir, testRel);
    let content = "";
    try {
      content = await fs.readFile(fullPath, "utf8");
    } catch {
      continue;
    }

    const { packageName: testPkg, importedClasses } = parseJavaPackageAndImports(content);
    const testSpans = extractJavaFunctionSpans(content);
    const { noComments } = stripCommentsAndMaskStrings(content);
    const lines = noComments.split("\n");
    let blockCounter = 0;

    function resolveJavaTarget(calleeName: string): JavaMethodAstMeta[] {
      const samePkg = javaMethodsByPkgAndName.get(`${testPkg}::${calleeName}`);
      if (samePkg && samePkg.length > 0) return samePkg;
      for (const cls of importedClasses) {
        const fromImp = javaMethodsByClassAndName.get(`${cls}::${calleeName}`);
        if (fromImp && fromImp.length > 0) return fromImp;
      }
      return javaMethodsByName.get(calleeName) ?? [];
    }

    for (const testSpan of testSpans) {
      const blockId = `${toPosix(testRel)}#${++blockCounter}`;
      const bodyText = lines.slice(testSpan.startLine - 1, testSpan.endLine).join("\n");

      const varToTargets = new Map<string, JavaMethodAstMeta[]>();
      const calledTargetsInBlock = new Map<string, JavaMethodAstMeta>();
      const outcomeForTarget = new Map<string, number>();
      const livenessForTarget = new Map<string, number>();

      // 1. Track variable assignments: `Type varName = obj.method(...)`
      const assignRe =
        /\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:[A-Za-z_][A-Za-z0-9_]*\s*\.\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
      let am: RegExpExecArray | null;
      while ((am = assignRe.exec(bodyText)) !== null) {
        const varName = am[1]!;
        const calleeName = am[2]!;
        const targets = resolveJavaTarget(calleeName);
        if (targets.length === 0) continue;
        for (const t of targets) {
          calledTargetsInBlock.set(`${t.fileStem}::${t.name}`, t);
        }
        varToTargets.set(varName, targets);
      }

      // 2. Track all calls in test method
      const callRe = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
      let cm: RegExpExecArray | null;
      while ((cm = callRe.exec(bodyText)) !== null) {
        for (const t of resolveJavaTarget(cm[1]!)) {
          calledTargetsInBlock.set(`${t.fileStem}::${t.name}`, t);
        }
      }

      function collectTargetsInExpr(expr: string): JavaMethodAstMeta[] {
        const found: JavaMethodAstMeta[] = [];
        for (const [vName, targets] of varToTargets.entries()) {
          if (new RegExp(`\\b${vName}\\b`).test(expr)) {
            found.push(...targets);
          }
        }
        const exprCallRe = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
        let ecm: RegExpExecArray | null;
        while ((ecm = exprCallRe.exec(expr)) !== null) {
          found.push(...resolveJavaTarget(ecm[1]!));
        }
        return found;
      }

      // 3. JUnit Outcome Assertions: `assertEquals(...)`, `assertNotEquals(...)`, `assertArrayEquals(...)`, `assertThrows(...)`, `assertTrue(...)`, `assertFalse(...)`
      const junitOutcomeRe =
        /\b(?:assertEquals|assertNotEquals|assertArrayEquals|assertIterableEquals|assertLinesMatch|assertThrows|assertThrowsExactly|assertSame|assertNotSame|assertTrue|assertFalse)\s*\(([^;]+)\)/g;
      let jom: RegExpExecArray | null;
      while ((jom = junitOutcomeRe.exec(bodyText)) !== null) {
        const expr = jom[1]!;
        const isNullCheckOnly =
          /\b(?:!=|==)\s*null\b/.test(expr) && !/(?:==|!=)\s*[^n\s]/.test(expr);
        for (const t of collectTargetsInExpr(expr)) {
          const k = `${t.fileStem}::${t.name}`;
          if (isNullCheckOnly) {
            livenessForTarget.set(k, (livenessForTarget.get(k) ?? 0) + 1);
          } else {
            outcomeForTarget.set(k, (outcomeForTarget.get(k) ?? 0) + 1);
          }
        }
      }

      // 4. JUnit Liveness Checks: `assertNotNull(...)`, `assertDoesNotThrow(...)`
      const junitLivenessRe = /\b(?:assertNotNull|assertDoesNotThrow)\s*\(([^;]+)\)/g;
      let jlm: RegExpExecArray | null;
      while ((jlm = junitLivenessRe.exec(bodyText)) !== null) {
        for (const t of collectTargetsInExpr(jlm[1]!)) {
          const k = `${t.fileStem}::${t.name}`;
          livenessForTarget.set(k, (livenessForTarget.get(k) ?? 0) + 1);
        }
      }

      // 5. AssertJ chains: `assertThat(<expr>).<matcher>(...)`
      const assertJRe = /\bassertThat\s*\(([^;]+?)\)\s*\.\s*([A-Za-z0-9_]+)\s*\(/g;
      let ajm: RegExpExecArray | null;
      while ((ajm = assertJRe.exec(bodyText)) !== null) {
        const subject = ajm[1]!;
        const matcher = ajm[2]!;
        const targets = collectTargetsInExpr(subject);
        const isLiveness = /^(?:isNotNull|isPresent|isNotEmpty)$/.test(matcher);
        for (const t of targets) {
          const k = `${t.fileStem}::${t.name}`;
          if (isLiveness) {
            livenessForTarget.set(k, (livenessForTarget.get(k) ?? 0) + 1);
          } else {
            outcomeForTarget.set(k, (outcomeForTarget.get(k) ?? 0) + 1);
          }
        }
      }

      // 6. Explicit value comparisons that throw an exception on mismatch
      for (const tc of extractJavaThrowComparisonExpressions(bodyText)) {
        for (const t of collectTargetsInExpr(tc.cond)) {
          const k = `${t.fileStem}::${t.name}`;
          if (tc.isNullCheckOnly) {
            livenessForTarget.set(k, (livenessForTarget.get(k) ?? 0) + 1);
          } else {
            outcomeForTarget.set(k, (outcomeForTarget.get(k) ?? 0) + 1);
          }
        }
      }

      for (const [k, target] of calledTargetsInBlock.entries()) {
        const ev = getOrCreateEv(target.fileStem, target.name);
        ev.executedBlocks.add(blockId);
        ev.testFiles.add(toPosix(testRel));
        const oc = outcomeForTarget.get(k) ?? 0;
        const lc = livenessForTarget.get(k) ?? 0;
        if (oc > 0) {
          ev.outcomeAssertedBlocks.add(blockId);
          ev.directOutcomeAssertions += oc;
        } else if (lc > 0) {
          ev.livenessCheckedBlocks.add(blockId);
          ev.directLivenessChecks += lc;
        }
      }
    }
  }

  return {
    evidenceEntries: Array.from(evidenceMap.values()),
    callGraphEdges,
  };
}

function isJavaValueComparisonExpr(cond: string): {
  hasComparison: boolean;
  isNullCheckOnly: boolean;
} {
  const withoutNullChecks = cond
    .replace(/\b[A-Za-z0-9_$.()]+\s*(?:==|!=)\s*null\b/g, "")
    .replace(/\bnull\s*(?:==|!=)\s*[A-Za-z0-9_$.()]+\b/g, "")
    .replace(/\bObjects\.(?:isNull|nonNull)\s*\([^)]*\)/g, "")
    .replace(/&&|\|\||\s+/g, "");
  const hasNullCheck =
    /\b(?:==|!=)\s*null\b|\bnull\s*(?:==|!=)\b|\bObjects\.(?:isNull|nonNull)\b/.test(cond);
  if (hasNullCheck && withoutNullChecks.length === 0) {
    return { hasComparison: true, isNullCheckOnly: true };
  }
  const hasValueOp =
    /(?:!=|==|<=|>=|<|>)/.test(withoutNullChecks) ||
    /\.\s*(?:equals|equalsIgnoreCase|contentEquals|compareTo|startsWith|endsWith|contains|matches)\s*\(/.test(
      cond,
    ) ||
    /\b(?:Objects\.(?:equals|deepEquals)|Arrays\.(?:equals|deepEquals)|(?:Double|Float|Integer|Long)\.compare)\s*\(/.test(
      cond,
    );
  return { hasComparison: hasValueOp, isNullCheckOnly: false };
}

export function extractJavaThrowComparisonExpressions(
  sourceText: string,
): Array<{ cond: string; isNullCheckOnly: boolean }> {
  const { noComments, masked } = stripCommentsAndMaskStrings(sourceText);
  const results: Array<{ cond: string; isNullCheckOnly: boolean }> = [];
  const ifRe = /\bif\s*\(/g;
  let m: RegExpExecArray | null;

  while ((m = ifRe.exec(masked)) !== null) {
    const openParenIdx = masked.indexOf("(", m.index);
    if (openParenIdx === -1) continue;
    const closeParenIdx = findMatchingDelimiter(masked, openParenIdx, "(", ")");
    if (closeParenIdx === -1) continue;

    const cond = noComments.slice(openParenIdx + 1, closeParenIdx).trim();
    let cursor = closeParenIdx + 1;
    while (cursor < masked.length && /\s/.test(masked[cursor]!)) cursor++;

    let branchText = "";
    if (masked[cursor] === "{") {
      const closeBraceIdx = findMatchingDelimiter(masked, cursor, "{", "}");
      if (closeBraceIdx === -1) continue;
      branchText = noComments.slice(cursor, closeBraceIdx + 1);
    } else {
      const semiIdx = masked.indexOf(";", cursor);
      if (semiIdx === -1) continue;
      branchText = noComments.slice(cursor, semiIdx + 1);
    }

    if (/\bthrow\b/.test(branchText)) {
      const { hasComparison, isNullCheckOnly } = isJavaValueComparisonExpr(cond);
      if (hasComparison) {
        results.push({ cond, isNullCheckOnly });
      }
    }
  }

  return results;
}

/**
 * Counts Java Outcome Assertions in a standalone code snippet (e.g. a Markdown code block),
 * reusing the Java adapter's Outcome Assertion rules:
 * - JUnit `assertEquals`, `assertNotEquals`, `assertArrayEquals`, `assertThrows`, `assertTrue`, `assertFalse`, etc. (excluding pure null checks and `assertNotNull`/`assertDoesNotThrow` Liveness Checks)
 * - AssertJ `assertThat(x).isEqualTo(y)` etc. (excluding `isNotNull`/`isPresent`/`isNotEmpty` Liveness Checks)
 * - Explicit value comparisons that throw an exception on mismatch (`if (x != expected) throw new ...`) and `assert x == expected;`
 * - `System.out.println` and comments are never counted as assertions.
 */
export function countJavaOutcomeAssertions(sourceText: string): number {
  const { noComments } = stripCommentsAndMaskStrings(sourceText);
  let count = 0;

  const junitOutcomeRe =
    /\b(?:assertEquals|assertNotEquals|assertArrayEquals|assertIterableEquals|assertLinesMatch|assertThrows|assertThrowsExactly|assertSame|assertNotSame|assertTrue|assertFalse)\s*\(([^;]+)\)/g;
  let jom: RegExpExecArray | null;
  while ((jom = junitOutcomeRe.exec(noComments)) !== null) {
    const expr = jom[1]!;
    const isNullCheckOnly =
      /\b(?:!=|==)\s*null\b/.test(expr) && !/(?:==|!=)\s*[^n\s]/.test(expr);
    if (!isNullCheckOnly) {
      count++;
    }
  }

  const assertJRe = /\bassertThat\s*\(([^;]+?)\)\s*\.\s*([A-Za-z0-9_]+)\s*\(/g;
  let ajm: RegExpExecArray | null;
  while ((ajm = assertJRe.exec(noComments)) !== null) {
    const matcher = ajm[2]!;
    const isLiveness = /^(?:isNotNull|isPresent|isNotEmpty)$/.test(matcher);
    if (!isLiveness) {
      count++;
    }
  }

  const assertJThrownRe = /\bassertThatThrownBy\s*\(/g;
  while (assertJThrownRe.exec(noComments) !== null) {
    count++;
  }

  for (const tc of extractJavaThrowComparisonExpressions(sourceText)) {
    if (!tc.isNullCheckOnly) {
      count++;
    }
  }

  const javaAssertRe = /\bassert\s+([^;:]+)(?::[^;]+)?;/g;
  let jam: RegExpExecArray | null;
  while ((jam = javaAssertRe.exec(noComments)) !== null) {
    const { hasComparison, isNullCheckOnly } = isJavaValueComparisonExpr(jam[1]!);
    if (hasComparison && !isNullCheckOnly) {
      count++;
    }
  }

  return count;
}

// ============================================================================
// Unified LanguageAdapter Registry & Seam Dispatchers
// ============================================================================

export const goLanguageAdapter: LanguageAdapter = {
  id: "go",
  isSourceFile: (f) =>
    f.endsWith(".go") &&
    !f.endsWith("_test.go") &&
    !f.endsWith(".pb.go") &&
    !f.endsWith("_gen.go"),
  isTestFile: (f) => f.endsWith("_test.go"),
  extractFunctionSpans: (src) => extractGoFunctionSpans(src),
  extractSymbols: (src, filePath) => extractGoSymbols(src, filePath),
  extractRuntimeFingerprints: (src) => {
    const map = new Map<string, string>();
    for (const s of extractGoFunctionSpans(src)) map.set(s.name, s.runtimeFingerprint);
    return map;
  },
  generateCandidateMutations: (src, start, end) => generateGoCandidateMutations(src, start, end),
  defaultTestCommand: async () => "go test ./...",
  analyzeAstEvidence: (rootDir, srcFiles, testFiles) =>
    analyzeGoFilesAstEvidence(rootDir, srcFiles, testFiles),
};

export const rustLanguageAdapter: LanguageAdapter = {
  id: "rust",
  isSourceFile: (f) => f.endsWith(".rs") && !/(?:^|\/)tests\//.test(f.replace(/\\/g, "/")),
  isTestFile: (f) => f.endsWith(".rs") && /(?:^|\/)tests\//.test(f.replace(/\\/g, "/")),
  extractFunctionSpans: (src) => extractRustFunctionSpans(src),
  extractSymbols: (src, filePath) => extractRustSymbols(src, filePath),
  extractRuntimeFingerprints: (src) => {
    const map = new Map<string, string>();
    for (const s of extractRustFunctionSpans(src)) map.set(s.name, s.runtimeFingerprint);
    return map;
  },
  generateCandidateMutations: (src, start, end) => generateRustCandidateMutations(src, start, end),
  defaultTestCommand: async () => "cargo test",
  analyzeAstEvidence: (rootDir, srcFiles, testFiles) =>
    analyzeRustFilesAstEvidence(rootDir, srcFiles, testFiles),
  filterProductionLines: (lines, spans) => {
    if (spans.length === 0) return;
    for (const ln of Array.from(lines.keys())) {
      if (!spans.some((s) => ln >= s.startLine && ln <= s.endLine)) {
        lines.delete(ln);
      }
    }
  },
  extractInlineTestBlockFingerprints: (src) => {
    const map = new Map<string, string>();
    const rawBlockFp = extractRustInlineTestFingerprint(src);
    if (rawBlockFp) {
      map.set("__inline_test_blocks__", rawBlockFp);
    }
    for (const f of parseAllRustFunctions(src)) {
      if (f.isTest) {
        map.set(f.name, f.runtimeFingerprint);
      }
    }
    return map;
  },
};

export const javaLanguageAdapter: LanguageAdapter = {
  id: "java",
  isSourceFile: (f) => f.endsWith(".java") && !javaLanguageAdapter.isTestFile(f),
  isTestFile: (f) => {
    const norm = f.replace(/\\/g, "/");
    return (
      norm.endsWith(".java") &&
      (/(?:^|\/)src\/test\//.test(norm) || /(?:Test|Tests|IT)\.java$/.test(norm))
    );
  },
  extractFunctionSpans: (src) => extractJavaFunctionSpans(src),
  extractSymbols: (src, filePath) => extractJavaSymbols(src, filePath),
  extractRuntimeFingerprints: (src) => {
    const map = new Map<string, string>();
    for (const s of extractJavaFunctionSpans(src)) map.set(s.name, s.runtimeFingerprint);
    return map;
  },
  generateCandidateMutations: (src, start, end) => generateJavaCandidateMutations(src, start, end),
  defaultTestCommand: async (rootDir) => {
    try {
      await fs.access(path.join(rootDir, "gradlew"));
      return "./gradlew test";
    } catch {
      return "mvn test";
    }
  },
  analyzeAstEvidence: (rootDir, srcFiles, testFiles) =>
    analyzeJavaFilesAstEvidence(rootDir, srcFiles, testFiles),
};

export const POLYGLOT_LANGUAGE_ADAPTERS: readonly LanguageAdapter[] = [
  goLanguageAdapter,
  rustLanguageAdapter,
  javaLanguageAdapter,
];

export function getPolyglotAdapter(filePath: string): LanguageAdapter | undefined {
  return POLYGLOT_LANGUAGE_ADAPTERS.find(
    (a) => a.isSourceFile(filePath) || a.isTestFile(filePath),
  );
}

export function isPolyglotSourceFile(fileName: string): boolean {
  return POLYGLOT_LANGUAGE_ADAPTERS.some((a) => a.isSourceFile(fileName));
}

export function isPolyglotTestFile(fileName: string): boolean {
  return POLYGLOT_LANGUAGE_ADAPTERS.some((a) => a.isTestFile(fileName));
}

export function extractPolyglotFunctionSpans(
  sourceText: string,
  fileName: string,
): PolyglotFunctionSpan[] {
  return getPolyglotAdapter(fileName)?.extractFunctionSpans(sourceText, fileName) ?? [];
}

export function extractPolyglotRuntimeFingerprints(
  sourceText: string,
  fileName: string,
): Map<string, string> {
  return (
    getPolyglotAdapter(fileName)?.extractRuntimeFingerprints(sourceText, fileName) ?? new Map()
  );
}

export function isCompilerErrorOutput(output: string): boolean {
  return (
    /cannot use .* in return statement/i.test(output) ||
    /not enough arguments to return/i.test(output) ||
    /too many arguments to return/i.test(output) ||
    /syntax error:/i.test(output) ||
    /undefined:/i.test(output) ||
    /error\[E\d+\]:/i.test(output) ||
    /error: incompatible types/i.test(output) ||
    /error: missing return statement/i.test(output)
  );
}
