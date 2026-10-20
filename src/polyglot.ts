import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface PolyglotFunctionSpan {
  name: string;
  startLine: number;
  endLine: number;
  cyclomaticComplexity: number;
  returnSignature: string;
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

function countComplexityInMaskedSlice(maskedSlice: string): number {
  let complexity = 1;
  const branchKeywords = /\b(if|for|while|case|catch|match)\b/g;
  const logicalOps = /(&&|\|\|)/g;
  const m1 = maskedSlice.match(branchKeywords);
  if (m1) complexity += m1.length;
  const m2 = maskedSlice.match(logicalOps);
  if (m2) complexity += m2.length;
  return complexity;
}

export function extractGoFunctionSpans(sourceText: string): PolyglotFunctionSpan[] {
  const { noComments, masked } = stripCommentsAndMaskStrings(sourceText);
  const lineStarts = buildLineStarts(sourceText);
  const spans: PolyglotFunctionSpan[] = [];

  // Match top-level `func` declarations at start of line
  const funcRegex = /^[ \t]*func\b/gm;
  let match: RegExpExecArray | null;

  while ((match = funcRegex.exec(masked)) !== null) {
    const funcStartIdx = match.index;
    let cursor = funcStartIdx + match[0].length;

    // Optional receiver: (r *Recv)
    while (cursor < masked.length && /\s/.test(masked[cursor]!)) cursor++;
    if (masked[cursor] === "(") {
      const closeRecv = findMatchingDelimiter(masked, cursor, "(", ")");
      if (closeRecv === -1) continue;
      cursor = closeRecv + 1;
    }

    while (cursor < masked.length && /\s/.test(masked[cursor]!)) cursor++;
    const nameMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(masked.slice(cursor));
    if (!nameMatch) continue;
    const fnName = nameMatch[0];
    cursor += fnName.length;

    // Optional generic type params: [T any]
    while (cursor < masked.length && /\s/.test(masked[cursor]!)) cursor++;
    if (masked[cursor] === "[") {
      const closeGen = findMatchingDelimiter(masked, cursor, "[", "]");
      if (closeGen === -1) continue;
      cursor = closeGen + 1;
    }

    // Parameter list: (...)
    while (cursor < masked.length && /\s/.test(masked[cursor]!)) cursor++;
    if (masked[cursor] !== "(") continue;
    const closeParams = findMatchingDelimiter(masked, cursor, "(", ")");
    if (closeParams === -1) continue;
    cursor = closeParams + 1;

    // Find opening brace `{` of function body
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
      startLine,
      endLine,
      cyclomaticComplexity: countComplexityInMaskedSlice(bodyMasked),
      returnSignature,
      runtimeFingerprint: `${fnName}:${runtimeSlice}`,
    });

    funcRegex.lastIndex = closeBraceIdx + 1;
  }

  return spans;
}

export function isPolyglotSourceFile(fileName: string): boolean {
  if (fileName.endsWith(".go") && !fileName.endsWith("_test.go")) return true;
  if (fileName.endsWith(".rs") && !isPolyglotTestFile(fileName)) return true;
  if (fileName.endsWith(".java") && !isPolyglotTestFile(fileName)) return true;
  return false;
}

export function isPolyglotTestFile(fileName: string): boolean {
  const norm = fileName.replace(/\\/g, "/");
  if (norm.endsWith("_test.go")) return true;
  if (norm.endsWith(".rs") && /(?:^|\/)tests\//.test(norm)) return true;
  if (
    norm.endsWith(".java") &&
    (/(?:^|\/)src\/test\//.test(norm) || /(?:Test|Tests|IT)\.java$/.test(norm))
  ) {
    return true;
  }
  return false;
}

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
      // Trait method signature without body
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
      cyclomaticComplexity: countComplexityInMaskedSlice(bodyMasked),
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

  // Match method declarations inside class/interface/enum bodies
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

    // Locate the actual return type from `noComments` at the same offset as `match[1]`
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
      cyclomaticComplexity: countComplexityInMaskedSlice(bodyMasked),
      returnSignature,
      runtimeFingerprint: `${methodName}:${runtimeSlice}`,
    });

    methodRegex.lastIndex = closeBraceIdx + 1;
  }

  return spans;
}

export function extractPolyglotFunctionSpans(
  sourceText: string,
  fileName: string,
): PolyglotFunctionSpan[] {
  if (fileName.endsWith(".go")) {
    return extractGoFunctionSpans(sourceText);
  }
  if (fileName.endsWith(".rs")) {
    return extractRustFunctionSpans(sourceText);
  }
  if (fileName.endsWith(".java")) {
    return extractJavaFunctionSpans(sourceText);
  }
  return [];
}

export function extractPolyglotRuntimeFingerprints(
  sourceText: string,
  fileName: string,
): Map<string, string> {
  const spans = extractPolyglotFunctionSpans(sourceText, fileName);
  const map = new Map<string, string>();
  for (const s of spans) {
    map.set(s.name, s.runtimeFingerprint);
  }
  return map;
}

function isGoErrorOnlyReturn(returnSignature: string): boolean {
  const sig = returnSignature.trim().replace(/^\(|\)$/g, "").trim();
  if (!sig) return false;
  // Splitting by comma for tuple returns like `int, error` or `val int, err error`
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
  if (
    /^(u?int(8|16|32|64|ptr)?|byte|rune|float(32|64)|complex(64|128))$/.test(t)
  ) {
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

  function inRange(line: number): boolean {
    if (startLine !== undefined && line < startLine) return false;
    if (endLine !== undefined && line > endLine) return false;
    return true;
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

  // 1. Function body clearance mutations (Pseudo-tested method detector)
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

  // 2. Operator & boolean mutations on non-comment lines
  const lines = sourceText.split("\n");
  const maskedLines = masked.split("\n");
  let lineOffset = 0;

  const opRules: Array<{ pattern: RegExp; replacements: string[] }> = [
    { pattern: /([A-Za-z0-9_)\]]+)\s*<=\s*([A-Za-z0-9_([\]]+)/g, replacements: ["<", ">"] },
    { pattern: /([A-Za-z0-9_)\]]+)\s*>=\s*([A-Za-z0-9_([\]]+)/g, replacements: [">", "<"] },
    { pattern: /([A-Za-z0-9_)\]]+)\s*==\s*([A-Za-z0-9_([\]]+)/g, replacements: ["!="] },
    { pattern: /([A-Za-z0-9_)\]]+)\s*!=\s*([A-Za-z0-9_([\]]+)/g, replacements: ["=="] },
  ];

  for (let idx = 0; idx < lines.length; idx++) {
    const lineNum = idx + 1;
    const rawLine = lines[idx]!;
    const mLine = maskedLines[idx]!;
    if (inRange(lineNum)) {
      for (const rule of opRules) {
        rule.pattern.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = rule.pattern.exec(mLine)) !== null) {
          const matchStart = lineOffset + m.index;
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
          } else {
            for (const rep of rule.replacements) {
              addMutation(matchStart, matchEnd, rep, lineNum);
            }
          }
        }
      }
    }
    lineOffset += rawLine.length + 1;
  }

  return candidates;
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

export interface GoFunctionAstMeta {
  name: string;
  fileStem: string;
  pkgDir: string;
  returnsErrorOnly: boolean;
  calledSymbols: string[];
}

export async function analyzeGoFilesAstEvidence(
  rootDir: string,
  goSourceFiles: string[],
  goTestFiles: string[],
): Promise<{
  evidenceEntries: Array<{
    fileStem: string;
    symbol: string;
    executedBlocks: Set<string>;
    strongAssertedBlocks: Set<string>;
    weakAssertedBlocks: Set<string>;
    directStrongAssertions: number;
    directWeakAssertions: number;
    testFiles: Set<string>;
  }>;
  callGraphEdges: Map<string, Set<string>>;
}> {
  const toPosix = (p: string) => p.replace(/\\/g, "/");
  const stripExt = (p: string) => p.replace(/\.go$/, "");

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
        if (callee !== span.name && !/^(if|for|switch|return|func|make|len|cap|append|new|panic)$/.test(callee)) {
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

  const evidenceMap = new Map<
    string,
    {
      fileStem: string;
      symbol: string;
      executedBlocks: Set<string>;
      strongAssertedBlocks: Set<string>;
      weakAssertedBlocks: Set<string>;
      directStrongAssertions: number;
      directWeakAssertions: number;
      testFiles: Set<string>;
    }
  >();

  function getOrCreateEv(fileStem: string, symbol: string) {
    const key = `${fileStem}::${symbol}`;
    let entry = evidenceMap.get(key);
    if (!entry) {
      entry = {
        fileStem,
        symbol,
        executedBlocks: new Set(),
        strongAssertedBlocks: new Set(),
        weakAssertedBlocks: new Set(),
        directStrongAssertions: 0,
        directWeakAssertions: 0,
        testFiles: new Set(),
      };
      evidenceMap.set(key, entry);
    }
    return entry;
  }

  for (const testRel of goTestFiles) {
    const fullPath = path.join(rootDir, testRel);
    let content = "";
    try {
      content = await fs.readFile(fullPath, "utf8");
    } catch {
      continue;
    }

    const testPkgDir = toPosix(path.dirname(testRel));
    const testSpans = extractGoFunctionSpans(content);
    const { noComments } = stripCommentsAndMaskStrings(content);
    const allLines = noComments.split("\n");
    let blockCounter = 0;

    for (const testSpan of testSpans) {
      if (!testSpan.name.startsWith("Test")) continue;
      const blockId = `${testRel}#${++blockCounter}`;
      const bodyLines = allLines.slice(testSpan.startLine - 1, testSpan.endLine);
      const bodyText = bodyLines.join("\n");

      // Track value variables vs error-only variables assigned from production calls
      const valueVarToTargets = new Map<string, GoFunctionAstMeta[]>();
      const errVarToTargets = new Map<string, GoFunctionAstMeta[]>();
      const calledTargetsInBlock = new Map<string, GoFunctionAstMeta>();
      const strongForTarget = new Map<string, number>();
      const weakForTarget = new Map<string, number>();

      function resolveGoTarget(calleeName: string): GoFunctionAstMeta[] {
        return (
          goFunctionsByPkgAndName.get(`${testPkgDir}::${calleeName}`) ??
          goFunctionsByName.get(calleeName) ??
          []
        );
      }

      // 1. Scan assignments:
      // e.g. `if err := ValidateCurrency("USD"); ...`
      // or `_, err := svc.Charge(100)`
      // or `ok, err := CanRefund(10)`
      // or `res := Calc(10)`
      const assignRe =
        /([A-Za-z0-9_, \t]+?)\s*(?::=|=)\s*(?:[A-Za-z0-9_]+\.)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
      let am: RegExpExecArray | null;
      while ((am = assignRe.exec(bodyText)) !== null) {
        const lhsRaw = am[1]!.trim().replace(/^\b(if|var)\b\s*/, "").trim();
        const calleeName = am[2]!;
        const targets = resolveGoTarget(calleeName);
        if (targets.length === 0) continue;

        for (const t of targets) {
          calledTargetsInBlock.set(`${t.fileStem}::${t.name}`, t);
        }

        const lhsVars = lhsRaw.split(",").map((s) => s.trim()).filter(Boolean);
        if (lhsVars.length === 1) {
          const v = lhsVars[0]!;
          if (v !== "_") {
            // If function returns error-only, single variable is an error variable whose check IS an outcome assertion!
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
          // Multi-return `(val, err)` in Go: first slot(s) are value outcomes, last slot is error
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
      const callRe = /(?:[A-Za-z0-9_]+\.)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
      let cm: RegExpExecArray | null;
      while ((cm = callRe.exec(bodyText)) !== null) {
        const calleeName = cm[1]!;
        const targets = resolveGoTarget(calleeName);
        for (const t of targets) {
          calledTargetsInBlock.set(`${t.fileStem}::${t.name}`, t);
        }
      }

      const ifFailRe =
        /\bif\s+([^{]+)\{[^}]*\b(?:t\.(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow))\b/gs;
      let im: RegExpExecArray | null;
      while ((im = ifFailRe.exec(bodyText)) !== null) {
        const rawCond = im[1]!;
        const semiIdx = rawCond.indexOf(";");
        const condExpr = semiIdx !== -1 ? rawCond.slice(semiIdx + 1) : rawCond;

        // If the `if` statement has an inline initializer `if lhs := fn(...); condExpr`,
        // scope variable checking to variables assigned in that inline initializer (or direct calls in condExpr).
        let inlineVars: Set<string> | null = null;
        if (semiIdx !== -1) {
          const initPart = rawCond.slice(0, semiIdx);
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

        // Check if any valueVar is referenced in condExpr
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
                weakForTarget.set(k, (weakForTarget.get(k) ?? 0) + 1);
              } else {
                strongForTarget.set(k, (strongForTarget.get(k) ?? 0) + 1);
              }
            }
          }
        }

        // Check if any direct function call is inside condExpr
        let dcm: RegExpExecArray | null;
        callRe.lastIndex = 0;
        while ((dcm = callRe.exec(condExpr)) !== null) {
          const targets = resolveGoTarget(dcm[1]!);
          for (const t of targets) {
            const k = `${t.fileStem}::${t.name}`;
            strongForTarget.set(k, (strongForTarget.get(k) ?? 0) + 1);
          }
        }

        // Check if an error variable from a `(T, error)` function is checked in condExpr
        for (const [errVar, targets] of errVarToTargets.entries()) {
          if (inlineVars && !inlineVars.has(errVar)) continue;
          const varRe = new RegExp(`\\b${errVar}\\b`);
          if (varRe.test(condExpr)) {
            for (const t of targets) {
              const k = `${t.fileStem}::${t.name}`;
              weakForTarget.set(k, (weakForTarget.get(k) ?? 0) + 1);
            }
          }
        }
      }

      // 4. Scan testify `assert.*` / `require.*` calls
      const testifyStrongRe =
        /\b(?:assert|require)\.(?:Equal|EqualValues|Exactly|ElementsMatch|True|False|NoError|Error|ErrorIs|Zero)\s*\(([^)]+)\)/g;
      let tm: RegExpExecArray | null;
      while ((tm = testifyStrongRe.exec(bodyText)) !== null) {
        const argsText = tm[1]!;
        for (const [valVar, targets] of valueVarToTargets.entries()) {
          if (new RegExp(`\\b${valVar}\\b`).test(argsText)) {
            for (const t of targets) {
              const k = `${t.fileStem}::${t.name}`;
              strongForTarget.set(k, (strongForTarget.get(k) ?? 0) + 1);
            }
          }
        }
        callRe.lastIndex = 0;
        let dcm: RegExpExecArray | null;
        while ((dcm = callRe.exec(argsText)) !== null) {
          for (const t of resolveGoTarget(dcm[1]!)) {
            const k = `${t.fileStem}::${t.name}`;
            strongForTarget.set(k, (strongForTarget.get(k) ?? 0) + 1);
          }
        }
      }

      const testifyWeakRe = /\b(?:assert|require)\.(?:NotNil|NotEmpty)\s*\(([^)]+)\)/g;
      while ((tm = testifyWeakRe.exec(bodyText)) !== null) {
        const argsText = tm[1]!;
        for (const [valVar, targets] of valueVarToTargets.entries()) {
          if (new RegExp(`\\b${valVar}\\b`).test(argsText)) {
            for (const t of targets) {
              const k = `${t.fileStem}::${t.name}`;
              weakForTarget.set(k, (weakForTarget.get(k) ?? 0) + 1);
            }
          }
        }
      }

      for (const [k, target] of calledTargetsInBlock.entries()) {
        const ev = getOrCreateEv(target.fileStem, target.name);
        ev.executedBlocks.add(blockId);
        ev.testFiles.add(toPosix(testRel));
        const sc = strongForTarget.get(k) ?? 0;
        const wc = weakForTarget.get(k) ?? 0;
        if (sc > 0) {
          ev.strongAssertedBlocks.add(blockId);
          ev.directStrongAssertions += sc;
        } else if (wc > 0) {
          ev.weakAssertedBlocks.add(blockId);
          ev.directWeakAssertions += wc;
        }
      }
    }
  }

  return {
    evidenceEntries: Array.from(evidenceMap.values()),
    callGraphEdges,
  };
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
  const { masked } = stripCommentsAndMaskStrings(sourceText);
  const inlineTestRanges = findRustInlineTestByteRanges(masked);
  const prodFns = parseAllRustFunctions(sourceText).filter((f) => !f.isTest);
  const candidates: PolyglotCandidateMutation[] = [];
  let seq = 1;

  function inRange(line: number): boolean {
    if (startLine !== undefined && line < startLine) return false;
    if (endLine !== undefined && line > endLine) return false;
    return true;
  }

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

  const lines = sourceText.split("\n");
  const maskedLines = masked.split("\n");
  let lineOffset = 0;

  const opRules: Array<{ pattern: RegExp; replacements: string[] }> = [
    { pattern: /([A-Za-z0-9_)\]]+)\s*<=\s*([A-Za-z0-9_([\]]+)/g, replacements: ["<", ">"] },
    { pattern: /([A-Za-z0-9_)\]]+)\s*>=\s*([A-Za-z0-9_([\]]+)/g, replacements: [">", "<"] },
    { pattern: /([A-Za-z0-9_)\]]+)\s*==\s*([A-Za-z0-9_([\]]+)/g, replacements: ["!="] },
    { pattern: /([A-Za-z0-9_)\]]+)\s*!=\s*([A-Za-z0-9_([\]]+)/g, replacements: ["=="] },
  ];

  for (let idx = 0; idx < lines.length; idx++) {
    const lineNum = idx + 1;
    const rawLine = lines[idx]!;
    const mLine = maskedLines[idx]!;
    if (inRange(lineNum) && !isOffsetInInlineTest(lineOffset)) {
      for (const rule of opRules) {
        rule.pattern.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = rule.pattern.exec(mLine)) !== null) {
          const matchStart = lineOffset + m.index;
          if (isOffsetInInlineTest(matchStart)) continue;
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

  return candidates;
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
): Promise<{
  evidenceEntries: Array<{
    fileStem: string;
    symbol: string;
    executedBlocks: Set<string>;
    strongAssertedBlocks: Set<string>;
    weakAssertedBlocks: Set<string>;
    directStrongAssertions: number;
    directWeakAssertions: number;
    testFiles: Set<string>;
  }>;
  callGraphEdges: Map<string, Set<string>>;
}> {
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

  const evidenceMap = new Map<
    string,
    {
      fileStem: string;
      symbol: string;
      executedBlocks: Set<string>;
      strongAssertedBlocks: Set<string>;
      weakAssertedBlocks: Set<string>;
      directStrongAssertions: number;
      directWeakAssertions: number;
      testFiles: Set<string>;
    }
  >();

  function getOrCreateEv(fileStem: string, symbol: string) {
    const key = `${fileStem}::${symbol}`;
    let entry = evidenceMap.get(key);
    if (!entry) {
      entry = {
        fileStem,
        symbol,
        executedBlocks: new Set(),
        strongAssertedBlocks: new Set(),
        weakAssertedBlocks: new Set(),
        directStrongAssertions: 0,
        directWeakAssertions: 0,
        testFiles: new Set(),
      };
      evidenceMap.set(key, entry);
    }
    return entry;
  }

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
      const strongForTarget = new Map<string, number>();
      const weakForTarget = new Map<string, number>();

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
              weakForTarget.set(k, (weakForTarget.get(k) ?? 0) + 1);
            }
          }
        } else if (varName === "_" && rhsTargets.length > 0 && /\.\s*(?:unwrap|expect)\s*\(/.test(rhs)) {
          for (const t of rhsTargets) {
            const k = `${t.fileStem}::${t.name}`;
            weakForTarget.set(k, (weakForTarget.get(k) ?? 0) + 1);
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

      // 3. Strong assertions: `assert_eq!(...)`, `assert_ne!(...)`, `matches!(...)`
      const strongMacroRe = /\b(?:assert_eq|assert_ne|debug_assert_eq|debug_assert_ne|assert_matches)!\s*\(([^;]+)\)/g;
      let sm: RegExpExecArray | null;
      while ((sm = strongMacroRe.exec(bodyText)) !== null) {
        const expr = sm[1]!;
        for (const t of collectTargetsInExpr(expr)) {
          const k = `${t.fileStem}::${t.name}`;
          strongForTarget.set(k, (strongForTarget.get(k) ?? 0) + 1);
        }
      }

      // 4. `assert!(<cond>)`: check if `<cond>` is purely `.is_ok()` / `.is_some()` / `.is_err()` / `.is_none()` (Liveness Check) vs concrete comparison (Outcome Assertion)
      const assertMacroRe = /\b(?:assert|debug_assert)!\s*\(([^;]+)\)/g;
      let am: RegExpExecArray | null;
      while ((am = assertMacroRe.exec(bodyText)) !== null) {
        const expr = am[1]!;
        const targets = collectTargetsInExpr(expr);
        if (targets.length === 0) continue;

        const isPureLiveness =
          /\.\s*(?:is_ok|is_some)\s*\(\s*\)/.test(expr) &&
          !/==|!=|<=|>=|<|>|\bmatches!\b/.test(expr);

        for (const t of targets) {
          const k = `${t.fileStem}::${t.name}`;
          if (isPureLiveness) {
            weakForTarget.set(k, (weakForTarget.get(k) ?? 0) + 1);
          } else {
            strongForTarget.set(k, (strongForTarget.get(k) ?? 0) + 1);
          }
        }
      }

      for (const [k, target] of calledTargetsInBlock.entries()) {
        const ev = getOrCreateEv(target.fileStem, target.name);
        ev.executedBlocks.add(blockId);
        ev.testFiles.add(toPosix(rel));
        const sc = strongForTarget.get(k) ?? 0;
        const wc = weakForTarget.get(k) ?? 0;
        if (sc > 0) {
          ev.strongAssertedBlocks.add(blockId);
          ev.directStrongAssertions += sc;
        } else if (wc > 0) {
          ev.weakAssertedBlocks.add(blockId);
          ev.directWeakAssertions += wc;
        }
      }
    }
  }

  return {
    evidenceEntries: Array.from(evidenceMap.values()),
    callGraphEdges,
  };
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
  const { masked } = stripCommentsAndMaskStrings(sourceText);
  const lineStarts = buildLineStarts(sourceText);
  const spans = extractJavaFunctionSpans(sourceText);
  const candidates: PolyglotCandidateMutation[] = [];
  let seq = 1;

  function inRange(line: number): boolean {
    if (startLine !== undefined && line < startLine) return false;
    if (endLine !== undefined && line > endLine) return false;
    return true;
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

  const lines = sourceText.split("\n");
  const maskedLines = masked.split("\n");
  let lineOffset = 0;

  const opRules: Array<{ pattern: RegExp; replacements: string[] }> = [
    { pattern: /([A-Za-z0-9_)\]]+)\s*<=\s*([A-Za-z0-9_([\]-]+)/g, replacements: ["<", ">"] },
    { pattern: /([A-Za-z0-9_)\]]+)\s*>=\s*([A-Za-z0-9_([\]-]+)/g, replacements: [">", "<"] },
    { pattern: /([A-Za-z0-9_)\]]+)\s*==\s*([A-Za-z0-9_([\]-]+)/g, replacements: ["!="] },
    { pattern: /([A-Za-z0-9_)\]]+)\s*!=\s*([A-Za-z0-9_([\]-]+)/g, replacements: ["=="] },
  ];

  for (let idx = 0; idx < lines.length; idx++) {
    const lineNum = idx + 1;
    const rawLine = lines[idx]!;
    const mLine = maskedLines[idx]!;
    if (inRange(lineNum)) {
      for (const rule of opRules) {
        rule.pattern.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = rule.pattern.exec(mLine)) !== null) {
          const matchStart = lineOffset + m.index;
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

  return candidates;
}

export interface JavaMethodAstMeta {
  name: string;
  fileStem: string;
  className: string;
  calledSymbols: string[];
}

export async function analyzeJavaFilesAstEvidence(
  rootDir: string,
  javaSourceFiles: string[],
  javaTestFiles: string[],
): Promise<{
  evidenceEntries: Array<{
    fileStem: string;
    symbol: string;
    executedBlocks: Set<string>;
    strongAssertedBlocks: Set<string>;
    weakAssertedBlocks: Set<string>;
    directStrongAssertions: number;
    directWeakAssertions: number;
    testFiles: Set<string>;
  }>;
  callGraphEdges: Map<string, Set<string>>;
}> {
  const toPosix = (p: string) => p.replace(/\\/g, "/");
  const stripExt = (p: string) => p.replace(/\.java$/, "");

  const javaMethodsByKey = new Map<string, JavaMethodAstMeta>();
  const javaMethodsByClassAndName = new Map<string, JavaMethodAstMeta[]>();
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
    "verify",
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
        className,
        calledSymbols,
      };
      const key = `${fileStem}::${span.name}`;
      javaMethodsByKey.set(key, meta);

      const clsKey = `${className}::${span.name}`;
      const clsList = javaMethodsByClassAndName.get(clsKey) ?? [];
      clsList.push(meta);
      javaMethodsByClassAndName.set(clsKey, clsList);

      const nameList = javaMethodsByName.get(span.name) ?? [];
      nameList.push(meta);
      javaMethodsByName.set(span.name, nameList);
    }
  }

  for (const [callerKey, meta] of javaMethodsByKey.entries()) {
    const edges = new Set<string>();
    for (const calleeName of meta.calledSymbols) {
      const sameCls = javaMethodsByClassAndName.get(`${meta.className}::${calleeName}`);
      const targets = sameCls ?? javaMethodsByName.get(calleeName) ?? [];
      for (const t of targets) {
        edges.add(`${t.fileStem}::${t.name}`);
      }
    }
    callGraphEdges.set(callerKey, edges);
  }

  const evidenceMap = new Map<
    string,
    {
      fileStem: string;
      symbol: string;
      executedBlocks: Set<string>;
      strongAssertedBlocks: Set<string>;
      weakAssertedBlocks: Set<string>;
      directStrongAssertions: number;
      directWeakAssertions: number;
      testFiles: Set<string>;
    }
  >();

  function getOrCreateEv(fileStem: string, symbol: string) {
    const key = `${fileStem}::${symbol}`;
    let entry = evidenceMap.get(key);
    if (!entry) {
      entry = {
        fileStem,
        symbol,
        executedBlocks: new Set(),
        strongAssertedBlocks: new Set(),
        weakAssertedBlocks: new Set(),
        directStrongAssertions: 0,
        directWeakAssertions: 0,
        testFiles: new Set(),
      };
      evidenceMap.set(key, entry);
    }
    return entry;
  }

  for (const testRel of javaTestFiles) {
    const fullPath = path.join(rootDir, testRel);
    let content = "";
    try {
      content = await fs.readFile(fullPath, "utf8");
    } catch {
      continue;
    }

    const testSpans = extractJavaFunctionSpans(content);
    const { noComments } = stripCommentsAndMaskStrings(content);
    const lines = noComments.split("\n");
    let blockCounter = 0;

    function resolveJavaTarget(calleeName: string): JavaMethodAstMeta[] {
      return javaMethodsByName.get(calleeName) ?? [];
    }

    for (const testSpan of testSpans) {
      const blockId = `${toPosix(testRel)}#${++blockCounter}`;
      const bodyText = lines.slice(testSpan.startLine - 1, testSpan.endLine).join("\n");

      const varToTargets = new Map<string, JavaMethodAstMeta[]>();
      const calledTargetsInBlock = new Map<string, JavaMethodAstMeta>();
      const strongForTarget = new Map<string, number>();
      const weakForTarget = new Map<string, number>();

      // 1. Track variable assignments: `Type varName = obj.method(...)` or `var varName = method(...)`
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

      // 3. JUnit Strong Outcome Assertions: `assertEquals(...)`, `assertNotEquals(...)`, `assertArrayEquals(...)`, `assertThrows(...)`, `verify(...)`
      const junitStrongRe =
        /\b(?:assertEquals|assertNotEquals|assertArrayEquals|assertIterableEquals|assertLinesMatch|assertThrows|assertThrowsExactly|assertSame|assertNotSame|verify)\s*\(([^;]+)\)/g;
      let jsm: RegExpExecArray | null;
      while ((jsm = junitStrongRe.exec(bodyText)) !== null) {
        for (const t of collectTargetsInExpr(jsm[1]!)) {
          const k = `${t.fileStem}::${t.name}`;
          strongForTarget.set(k, (strongForTarget.get(k) ?? 0) + 1);
        }
      }

      // 4. JUnit Weak Liveness Checks: `assertNotNull(...)`, `assertDoesNotThrow(...)`
      const junitWeakRe = /\b(?:assertNotNull|assertDoesNotThrow)\s*\(([^;]+)\)/g;
      let jwm: RegExpExecArray | null;
      while ((jwm = junitWeakRe.exec(bodyText)) !== null) {
        for (const t of collectTargetsInExpr(jwm[1]!)) {
          const k = `${t.fileStem}::${t.name}`;
          weakForTarget.set(k, (weakForTarget.get(k) ?? 0) + 1);
        }
      }

      // 5. AssertJ chains: `assertThat(<expr>).<matcher>(...)`
      const assertJRe = /\bassertThat\s*\(([^;]+?)\)\s*\.\s*([A-Za-z0-9_]+)\s*\(/g;
      let ajm: RegExpExecArray | null;
      while ((ajm = assertJRe.exec(bodyText)) !== null) {
        const subject = ajm[1]!;
        const matcher = ajm[2]!;
        const targets = collectTargetsInExpr(subject);
        const isWeak = /^(?:isNotNull|isPresent|isNotEmpty)$/.test(matcher);
        for (const t of targets) {
          const k = `${t.fileStem}::${t.name}`;
          if (isWeak) {
            weakForTarget.set(k, (weakForTarget.get(k) ?? 0) + 1);
          } else {
            strongForTarget.set(k, (strongForTarget.get(k) ?? 0) + 1);
          }
        }
      }

      for (const [k, target] of calledTargetsInBlock.entries()) {
        const ev = getOrCreateEv(target.fileStem, target.name);
        ev.executedBlocks.add(blockId);
        ev.testFiles.add(toPosix(testRel));
        const sc = strongForTarget.get(k) ?? 0;
        const wc = weakForTarget.get(k) ?? 0;
        if (sc > 0) {
          ev.strongAssertedBlocks.add(blockId);
          ev.directStrongAssertions += sc;
        } else if (wc > 0) {
          ev.weakAssertedBlocks.add(blockId);
          ev.directWeakAssertions += wc;
        }
      }
    }
  }

  return {
    evidenceEntries: Array.from(evidenceMap.values()),
    callGraphEdges,
  };
}
