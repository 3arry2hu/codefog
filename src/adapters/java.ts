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
  const { noComments, masked } = stripCommentsAndMaskStrings(sourceText, "java");
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
  const { noComments, masked } = stripCommentsAndMaskStrings(sourceText, "java");
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
  const { noComments, masked } = stripCommentsAndMaskStrings(sourceText, "java");
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
    const { noComments } = stripCommentsAndMaskStrings(content, "java");
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
    const { noComments } = stripCommentsAndMaskStrings(content, "java");
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
  const { noComments, masked } = stripCommentsAndMaskStrings(sourceText, "java");
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
  const { noComments } = stripCommentsAndMaskStrings(sourceText, "java");
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

export const javaLanguageAdapter: LanguageAdapter = {
  id: "java",
  countControlFlowBranches: (sourceText) => countSpanControlFlowBranches(extractJavaFunctionSpans(sourceText)),
  analyzeFunctionStructure: (sourceText, span) =>
    analyzeLexicalFunctionStructure(sourceText, span, "java"),
  extractFileDependencies: javaFileDependencies,
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


interface JavaDependencyIndex {
  classes: Map<string, string[]>;
  packages: Map<string, string[]>;
}

const javaDependencyIndexCache = new WeakMap<ReadonlySet<string>, {
  sourceTexts?: ReadonlyMap<string, string>;
  index: JavaDependencyIndex;
}>();

function javaDependencyIndex(
  repoFiles: ReadonlySet<string>,
  sourceTexts?: ReadonlyMap<string, string>,
): JavaDependencyIndex {
  const cached = javaDependencyIndexCache.get(repoFiles);
  if (cached && cached.sourceTexts === sourceTexts) return cached.index;
  const index: JavaDependencyIndex = { classes: new Map(), packages: new Map() };
  for (const file of repoFiles) {
    if (!file.endsWith(".java")) continue;
    const className = path.posix.basename(file, ".java");
    if (className === "package-info" || className === "module-info") continue;
    const source = sourceTexts?.get(file);
    const packageName = source === undefined
      ? path.posix.dirname(file).replace(/^.*(?:^|\/)src\/main\/java\/?/, "").replace(/\//g, ".").replace(/^\.$/, "")
      : /^\s*package\s+([\w.]+)\s*;/m.exec(stripCommentsAndMaskStrings(source, "java").masked)?.[1] ?? "";
    const classPath = [packageName, className].filter(Boolean).join(".");
    const classes = index.classes.get(classPath) ?? [];
    classes.push(file);
    index.classes.set(classPath, classes);
    const files = index.packages.get(packageName) ?? [];
    files.push(file);
    index.packages.set(packageName, files);
  }
  javaDependencyIndexCache.set(repoFiles, { sourceTexts, index });
  return index;
}

function javaFileDependencies(
  sourceText: string,
  filePath: string,
  repoFiles: ReadonlySet<string>,
  context?: FileDependencyContext,
): FileDependencyEdge[] {
  const from = filePath.replace(/\\/g, "/");
  const { masked } = stripCommentsAndMaskStrings(sourceText, "java");
  const lineStarts = buildLineStarts(sourceText);
  const index = javaDependencyIndex(repoFiles, context?.sourceTexts);
  const edges = new Map<string, FileDependencyEdge>();
  for (const match of masked.matchAll(/\bimport\s+(?:(static)\s+)?([\w.]+\*?)\s*;/g)) {
    const specifier = match[2]!;
    let files: string[] | undefined;
    if (!match[1] && specifier.endsWith(".*")) {
      files = index.packages.get(specifier.slice(0, -2));
    } else {
      // A static import (or imported nested class) resolves to its enclosing source class.
      const segments = specifier.split(".");
      if (match[1]) segments.pop();
      while (segments.length > 0 && !files) {
        files = index.classes.get(segments.join("."));
        segments.pop();
      }
    }
    if (!files && !context?.sourceTexts) {
      // When called with paths only, the package may be below a custom source root.
      const segments = specifier.split(".");
      if (match[1]) segments.pop();
      if (!match[1] && segments.at(-1) === "*") {
        segments.pop();
        const packageSuffix = "/" + segments.join("/");
        files = [...repoFiles].filter((file) => file.endsWith(".java") &&
          ("/" + path.posix.dirname(file)).endsWith(packageSuffix));
      } else {
        while (segments.length > 0 && !files?.length) {
          const classSuffix = "/" + segments.join("/") + ".java";
          files = [...repoFiles].filter((file) => ("/" + file).endsWith(classSuffix));
          segments.pop();
        }
      }
    }
    for (const to of files ?? []) {
      if (to !== from && !edges.has(to)) edges.set(to, { from, to, line: offsetToLine(lineStarts, match.index) });
    }
  }
  return [...edges.values()];
}
