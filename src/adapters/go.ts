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

export const goLanguageAdapter: LanguageAdapter = {
  id: "go",
  countControlFlowBranches: (sourceText) => countSpanControlFlowBranches(extractGoFunctionSpans(sourceText)),
  analyzeFunctionStructure: (sourceText, span) =>
    analyzeLexicalFunctionStructure(sourceText, span, "go"),
  extractFileDependencies: goFileDependencies,
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


const goModulesCache = new WeakMap<ReadonlyMap<string, string>, Array<{ dir: string; prefix: string }>>();

function goModules(sourceTexts?: ReadonlyMap<string, string>): Array<{ dir: string; prefix: string }> {
  if (!sourceTexts) return [];
  const cached = goModulesCache.get(sourceTexts);
  if (cached) return cached;
  const modules: Array<{ dir: string; prefix: string }> = [];
  for (const [file, text] of sourceTexts) {
    if (path.posix.basename(file) !== "go.mod") continue;
    const match = /^\s*module\s+(?:"([^"]+)"|([^\s]+))/m.exec(text);
    const prefix = (match?.[1] ?? match?.[2])?.replace(/\/+$/, "");
    if (prefix) modules.push({ dir: path.posix.dirname(file), prefix });
  }
  modules.sort((a, b) => b.prefix.length - a.prefix.length || a.dir.localeCompare(b.dir));
  goModulesCache.set(sourceTexts, modules);
  return modules;
}

const goPackageFilesCache = new WeakMap<ReadonlySet<string>, Map<string, string[]>>();

function goFileDependencies(
  sourceText: string,
  filePath: string,
  repoFiles: ReadonlySet<string>,
  context?: FileDependencyContext,
): FileDependencyEdge[] {
  const from = filePath.replace(/\\/g, "/");
  const modules = goModules(context?.sourceTexts);
  if (modules.length === 0 && !context?.goModulePrefix) return [];
  let packages = goPackageFilesCache.get(repoFiles);
  if (!packages) {
    packages = new Map<string, string[]>();
    for (const file of repoFiles) {
      if (!goLanguageAdapter.isSourceFile(file)) continue;
      const dir = path.posix.dirname(file);
      const files = packages.get(dir) ?? [];
      files.push(file);
      packages.set(dir, files);
    }
    goPackageFilesCache.set(repoFiles, packages);
  }
  const { masked, noComments } = stripCommentsAndMaskStrings(sourceText);
  const lineStarts = buildLineStarts(sourceText);
  const edges = new Map<string, FileDependencyEdge>();

  function addImport(packagePath: string, offset: number): void {
    const prefix = context?.goModulePrefix?.replace(/\/+$/, "");
    const module = modules.find((candidate) =>
      packagePath === candidate.prefix || packagePath.startsWith(candidate.prefix + "/"),
    ) ?? (prefix && (packagePath === prefix || packagePath.startsWith(prefix + "/"))
      ? { dir: ".", prefix } : undefined);
    if (!module) return;
    const packageDir = path.posix.join(module.dir, packagePath.slice(module.prefix.length + 1));
    for (const to of packages?.get(packageDir) ?? []) {
      if (to !== from && !edges.has(to)) {
        edges.set(to, { from, to, line: offsetToLine(lineStarts, offset) });
      }
    }
  }

  for (const statement of masked.matchAll(/(?:^|[;\n])[ \t]*\bimport\b/g)) {
    const importStart = statement.index + statement[0].length;
    const remaining = noComments.slice(importStart);
    const block = /^\s*\(/.exec(remaining);
    if (block) {
      const open = importStart + block[0].length - 1;
      const close = findMatchingDelimiter(masked, open, "(", ")");
      if (close === -1) continue;
      for (const specifier of noComments.slice(open + 1, close).matchAll(/(?:^|[;\n])[ \t]*(?:(?:\.|[\w]+)[ \t]+)?["`]([^"`\r\n]+)["`]/g)) {
        addImport(specifier[1]!, open + 1 + specifier.index + specifier[0].indexOf(specifier[1]!));
      }
    } else {
      const specifier = /^[ \t]*(?:(?:\.|[\w]+)[ \t]+)?["`]([^"`\r\n]+)["`]/.exec(remaining);
      if (specifier) addImport(specifier[1]!, importStart + specifier[0].indexOf(specifier[1]!));
    }
  }
  return [...edges.values()];
}
