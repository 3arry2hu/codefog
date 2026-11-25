import * as fs from "node:fs/promises";
import * as path from "node:path";
import { analyzeLexicalFunctionStructure } from "./lexical-structure.js";
import {
  buildLineStarts,
  collectOperatorMutations,
  countComplexityInMaskedSlice,
  countSpanControlFlowBranches,
  createEvidenceAccumulator,
  findMatchingDelimiter,
  offsetToLine,
  stripCommentsAndMaskStrings,
  type FileDependencyContext,
  type FileDependencyEdge,
  type LanguageAdapter,
  type PolyglotCandidateMutation,
  type PolyglotExtractedSymbol,
  type PolyglotFunctionSpan,
  type PolyglotRepoAstEvidence,
} from "./shared.js";

export function findRustInlineTestByteRanges(
  masked: string,
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const attrRe = /#\s*\[\s*(?:cfg\s*\(\s*test\s*\)|(?:\w+::)*test)\s*\]/g;
  let m: RegExpExecArray | null;

  while ((m = attrRe.exec(masked)) !== null) {
    const startIdx = m.index;
    // The attributed item may end at a semicolon (an external module or import).
    for (let i = attrRe.lastIndex; i < masked.length; i++) {
      const token = masked[i];
      if (token === "(" || token === "[") {
        const close = findMatchingDelimiter(masked, i, token, token === "(" ? ")" : "]");
        if (close === -1) break;
        i = close;
      } else if (token === ";" || token === "{") {
        const close = token === ";" ? i : findMatchingDelimiter(masked, i, "{", "}");
        if (close === -1) break;
        ranges.push({ start: startIdx, end: close + 1 });
        attrRe.lastIndex = close + 1;
        break;
      }
    }
  }

  return ranges;
}

export function extractRustInlineTestFingerprint(sourceText: string): string {
  const { noComments, masked } = stripCommentsAndMaskStrings(sourceText, "rust");
  const ranges = findRustInlineTestByteRanges(masked);
  if (ranges.length === 0) return "";
  return ranges
    .map((r) => noComments.slice(r.start, r.end).replace(/\s+/g, " ").trim())
    .join("||");
}

function parseAllRustFunctions(
  sourceText: string,
): Array<PolyglotFunctionSpan & { isTest: boolean; startOffset: number; endOffset: number }> {
  const { noComments, masked } = stripCommentsAndMaskStrings(sourceText, "rust");
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
  const { noComments, masked } = stripCommentsAndMaskStrings(sourceText, "rust");
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
  const { noComments, masked } = stripCommentsAndMaskStrings(sourceText, "rust");
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
  const { noComments } = stripCommentsAndMaskStrings(sourceText, "rust");
  return extractRustAssertionSpans(noComments).filter((s) => s.kind === "outcome").length;
}

export function hasRustMainFunction(sourceText: string): boolean {
  const { masked } = stripCommentsAndMaskStrings(sourceText, "rust");
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
    const { noComments } = stripCommentsAndMaskStrings(content, "rust");
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

export const rustLanguageAdapter: LanguageAdapter = {
  id: "rust",
  countControlFlowBranches: (sourceText) => countSpanControlFlowBranches(extractRustFunctionSpans(sourceText)),
  analyzeFunctionStructure: (sourceText, span, filePath) =>
    analyzeLexicalFunctionStructure(sourceText, span, "rust", findRustInlineTestByteRanges, Boolean(filePath && rustLanguageAdapter.isTestFile(filePath))),
  extractFileDependencies: rustFileDependencies,
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


interface CargoCrate {
  name: string;
  directory: string;
  sourceRoot: string;
  entry: string;
  manifest: string;
}

const cargoCrateCache = new WeakMap<ReadonlySet<string>, {
  sourceTexts?: ReadonlyMap<string, string>;
  crates: CargoCrate[];
}>();

function cargoTable(manifest: string, table: string): string {
  const header = `[${table}]`;
  const lines = manifest.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === header || line.trim().startsWith(header + " #"));
  if (start === -1) return "";
  const end = lines.findIndex((line, i) => i > start && /^\s*\[/.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
}

function readLocalCargoDependencies(
  manifest: string,
  tableName: string,
): Array<{ alias: string; path?: string; workspace: boolean }> {
  const dependencyTable = cargoTable(manifest, tableName);
  const dependencies: Array<{ alias: string; path?: string; workspace: boolean }> = [];
  for (const match of dependencyTable.matchAll(/^\s*([\w-]+)\s*=\s*\{([^}]+)\}/gm)) {
    dependencies.push({
      alias: match[1]!.replace(/-/g, "_"),
      path: /\bpath\s*=\s*["']([^"']+)["']/.exec(match[2]!)?.[1],
      workspace: /\bworkspace\s*=\s*true\b/.test(match[2]!),
    });
  }
  for (const match of dependencyTable.matchAll(/^\s*([\w-]+)\.workspace\s*=\s*true\b/gm)) {
    dependencies.push({ alias: match[1]!.replace(/-/g, "_"), workspace: true });
  }
  for (const match of manifest.matchAll(/^\s*\[([\w.-]+)\.([\w-]+)\]\s*$/gm)) {
    if (match[1] !== tableName) continue;
    const fields = cargoTable(manifest, `${tableName}.${match[2]!}`);
    dependencies.push({
      alias: match[2]!.replace(/-/g, "_"),
      path: cargoString(fields, "path"),
      workspace: /^\s*workspace\s*=\s*true\b/m.test(fields),
    });
  }
  return dependencies;
}

function cargoString(table: string, key: string): string | undefined {
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, "m");
  return pattern.exec(table)?.[1];
}

const cargoAliasesCache = new WeakMap<CargoCrate, Map<string, CargoCrate>>();

function cargoDependencyAliases(
  crate: CargoCrate | undefined,
  crates: CargoCrate[],
  sourceTexts?: ReadonlyMap<string, string>,
): Map<string, CargoCrate> {
  if (!crate) return new Map();
  const cached = cargoAliasesCache.get(crate);
  if (cached) return cached;
  const aliases = new Map<string, CargoCrate>();
  let directory = crate.directory;
  let workspaceDependencies = new Map<string, string>();
  while (true) {
    const manifest = sourceTexts?.get(path.posix.join(directory, "Cargo.toml")) ?? "";
    if (/^\s*\[workspace(?:\]|\.)/m.test(manifest)) {
      workspaceDependencies = new Map(readLocalCargoDependencies(manifest, "workspace.dependencies")
        .filter((dep) => dep.path !== undefined)
        .map((dep) => [dep.alias, path.posix.join(directory, dep.path!)]));
      break;
    }
    const parent = path.posix.dirname(directory);
    if (directory === parent) break;
    directory = parent;
  }
  for (const table of ["dependencies", "dev-dependencies", "build-dependencies"]) {
    for (const dep of readLocalCargoDependencies(crate.manifest, table)) {
      const source = dep.path ? path.posix.join(crate.directory, dep.path)
        : dep.workspace ? workspaceDependencies.get(dep.alias) : undefined;
      const target = source && crates.find((candidate) => candidate.directory === source);
      if (target) aliases.set(dep.alias, target);
    }
  }
  cargoAliasesCache.set(crate, aliases);
  return aliases;
}

function cargoCrates(
  repoFiles: ReadonlySet<string>,
  sourceTexts?: ReadonlyMap<string, string>,
): CargoCrate[] {
  const cached = cargoCrateCache.get(repoFiles);
  if (cached && cached.sourceTexts === sourceTexts) return cached.crates;
  const byDirectory = new Map<string, CargoCrate>();
  for (const [file, manifest] of sourceTexts ?? []) {
    if (path.posix.basename(file) !== "Cargo.toml") continue;
    const packageName = cargoString(cargoTable(manifest, "package"), "name");
    const library = cargoTable(manifest, "lib");
    const name = cargoString(library, "name") ?? packageName;
    if (!name) continue;
    const directory = path.posix.dirname(file);
    const declared = path.posix.join(directory, cargoString(library, "path") ?? "src/lib.rs");
    const entry = repoFiles.has(declared) ? declared : path.posix.join(directory, "src/main.rs");
    if (repoFiles.has(entry)) {
      byDirectory.set(directory, {
        name: name.replace(/-/g, "_"),
        directory,
        sourceRoot: path.posix.dirname(entry),
        entry,
        manifest,
      });
    }
  }
  for (const file of repoFiles) {
    const match = /^(.*\/)?src\/(?:lib|main)\.rs$/.exec(file);
    if (!match) continue;
    const directory = match[1]?.slice(0, -1) ?? ".";
    if (byDirectory.has(directory)) continue;
    const lib = path.posix.join(directory, "src", "lib.rs");
    const entry = repoFiles.has(lib) ? lib : file;
    byDirectory.set(directory, {
      name: path.posix.basename(directory).replace(/-/g, "_"),
      directory,
      sourceRoot: path.posix.dirname(entry),
      entry,
      manifest: "",
    });
  }
  const crates = [...byDirectory.values()].sort((a, b) =>
    b.sourceRoot.length - a.sourceRoot.length || a.entry.localeCompare(b.entry));
  cargoCrateCache.set(repoFiles, { sourceTexts, crates });
  return crates;
}

function expandRustUse(
  expression: string,
  addPath: (segments: string[]) => void,
): void {
  const tokens = expression.match(/[A-Za-z_]\w*|::|[{},*]/g) ?? [];
  let cursor = 0;

  function item(prefix: string[]): void {
    const segments = [...prefix];
    while (cursor < tokens.length) {
      const token = tokens[cursor++]!;
      if (token === "::") continue;
      if (token === "{") {
        while (cursor < tokens.length && tokens[cursor] !== "}") {
          item(segments);
        }
        if (tokens[cursor] === "}") cursor++;
        if (tokens[cursor] === ",") cursor++;
        return;
      }
      if (token === "as") {
        cursor++;
        break;
      }
      if (token === "}") {
        cursor--;
        break;
      }
      if (token === ",") break;
      if (token !== "*" && !(token === "self" && segments.length > 0)) segments.push(token);
    }
    if (segments.length > 0) addPath(segments);
  }

  item([]);
}

function resolveRustModuleFile(
  directory: string,
  segments: string[],
  repoFiles: ReadonlySet<string>,
): string | undefined {
  for (let end = segments.length; end > 0; end--) {
    const stem = path.posix.join(directory, ...segments.slice(0, end));
    if (repoFiles.has(stem + ".rs")) return stem + ".rs";
    if (repoFiles.has(stem + "/mod.rs")) return stem + "/mod.rs";
  }
  return undefined;
}

function rustFileDependencies(
  sourceText: string,
  filePath: string,
  repoFiles: ReadonlySet<string>,
  context?: FileDependencyContext,
): FileDependencyEdge[] {
  const from = filePath.replace(/\\/g, "/");
  const { masked, noComments } = stripCommentsAndMaskStrings(sourceText, "rust");
  const testRanges = findRustInlineTestByteRanges(masked);
  const lineStarts = buildLineStarts(sourceText);
  const crates = cargoCrates(repoFiles, context?.sourceTexts);
  const crate = crates.find(({ sourceRoot }) => sourceRoot === "." || from.startsWith(sourceRoot + "/"));
  const mainFile = path.posix.basename(from) === "main.rs" || /(?:^|\/)src\/bin\/[^/]+\.rs$/.test(from);
  const crateRoot = mainFile ? path.posix.dirname(from) : crate?.sourceRoot ??
    /^(.*(?:^|\/)src)\//.exec(from)?.[1] ?? path.posix.dirname(from);
  const entry = mainFile ? from : crate?.entry ??
    ["lib.rs", "main.rs"].map((file) => path.posix.join(crateRoot, file)).find((file) => repoFiles.has(file));
  const dependencyAliases = cargoDependencyAliases(crate, crates, context?.sourceTexts);

  const inlineModules: Array<{ from: number; to: number; name: string }> = [];
  const declarations = [...masked.matchAll(/\bmod\s+([A-Za-z_]\w*)\s*([;{])/g)];
  for (const match of declarations) {
    if (match[2] !== "{") continue;
    const open = match.index + match[0].length - 1;
    const close = findMatchingDelimiter(masked, open, "{", "}");
    if (close !== -1) inlineModules.push({ from: open, to: close, name: match[1]! });
  }
  const fileModule = from === entry || path.posix.basename(from) === "mod.rs"
    ? path.posix.dirname(from) : from.slice(0, -3);
  const directoryAt = (offset: number) => path.posix.join(fileModule, ...inlineModules
    .filter((module) => module.from < offset && offset < module.to)
    .map((module) => module.name));
  const edges = new Map<string, FileDependencyEdge>();
  function add(to: string | undefined, offset: number): void {
    if (!to || to === from || testRanges.some((range) => range.start <= offset && offset < range.end)) return;
    const line = offsetToLine(lineStarts, offset);
    if ((edges.get(to)?.line ?? Infinity) > line) edges.set(to, { from, to, line });
  }

  function usePath(segments: string[], offset: number): void {
    const first = segments[0];
    let directory = directoryAt(offset);
    if (first === "crate") {
      add(resolveRustModuleFile(crateRoot, segments.slice(1), repoFiles) ?? entry, offset);
      return;
    }
    if (first === "self" || first === "super") {
      const rest = [...segments];
      if (rest[0] === "self") rest.shift();
      while (rest[0] === "super") {
        if (directory === crateRoot) return;
        directory = path.posix.dirname(directory);
        rest.shift();
      }
      const self = directory === crateRoot ? entry :
        resolveRustModuleFile(crateRoot, path.posix.relative(crateRoot, directory).split("/"), repoFiles);
      add(resolveRustModuleFile(directory, rest, repoFiles) ?? self, offset);
      return;
    }
    if (!first || ["std", "core", "alloc"].includes(first)) return;
    const external = dependencyAliases.get(first) ?? crates.find((candidate) => candidate.name === first);
    if (external) {
      add(resolveRustModuleFile(external.sourceRoot, segments.slice(1), repoFiles) ?? external.entry, offset);
      return;
    }
    add(resolveRustModuleFile(directory, segments, repoFiles), offset);
  }

  for (const match of declarations) {
    if (match[2] !== ";") continue;
    const attributes = noComments.slice(0, match.index);
    const customPath = /#\s*\[\s*path\s*=\s*"([^"]+)"\s*\]\s*(?:pub(?:\([^)]*\))?\s*)?$/.exec(attributes)?.[1];
    const directory = directoryAt(match.index);
    if (customPath) {
      const base = directory === fileModule ? path.posix.dirname(from) : directory;
      const to = path.posix.join(base, customPath);
      if (repoFiles.has(to)) add(to, match.index);
    } else {
      add(resolveRustModuleFile(directory, [match[1]!], repoFiles), match.index);
    }
  }

  const useRanges: Array<{ start: number; end: number }> = [];
  for (const match of masked.matchAll(/\buse\s+([^;]+);/g)) {
    useRanges.push({ start: match.index, end: match.index + match[0].length });
    expandRustUse(match[1]!, (segments) => usePath(segments, match.index));
  }
  for (const match of masked.matchAll(/\b(?:crate|self|super)\s*::\s*[A-Za-z_]\w*(?:\s*::\s*[A-Za-z_]\w*)*/g)) {
    if (useRanges.some((range) => range.start <= match.index && match.index < range.end)) continue;
    usePath(match[0].split(/\s*::\s*/), match.index);
  }
  for (const match of masked.matchAll(/\bextern\s+crate\s+([A-Za-z_]\w*)/g)) {
    usePath([match[1]!], match.index);
  }

  return [...edges.values()];
}
