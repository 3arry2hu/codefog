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

    // Single-quoted char/rune '...'
    if (ch === "'") {
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
  return false;
}

export function isPolyglotTestFile(fileName: string): boolean {
  if (fileName.endsWith("_test.go")) return true;
  return false;
}

export function extractPolyglotFunctionSpans(
  sourceText: string,
  fileName: string,
): PolyglotFunctionSpan[] {
  if (fileName.endsWith(".go")) {
    return extractGoFunctionSpans(sourceText);
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
