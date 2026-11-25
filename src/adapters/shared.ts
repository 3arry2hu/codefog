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

export interface FileDependencyEdge {
  from: string;
  to: string;
  line: number;
}

export interface FileDependencyContext {
  goModulePrefix?: string;
  /** Source and manifest contents in the snapshot being analyzed, keyed by repository path. */
  sourceTexts?: ReadonlyMap<string, string>;
}

export interface FunctionLineSpan {
  name?: string;
  startLine: number;
  endLine: number;
}

export interface FunctionStructureMetrics {
  cognitiveComplexity: number;
  maxNestingDepth: number;
  errorMaskingLines: number[];
}

export interface LanguageAdapter {
  readonly id: SupportedLanguageId;
  isSourceFile(filePath: string): boolean;
  isTestFile(filePath: string): boolean;
  extractFunctionSpans(sourceText: string, filePath: string): PolyglotFunctionSpan[];
  extractSymbols(sourceText: string, filePath: string): PolyglotExtractedSymbol[];
  extractRuntimeFingerprints(sourceText: string, filePath: string): Map<string, string>;
  extractFileDependencies(
    sourceText: string,
    filePath: string,
    repoFiles: ReadonlySet<string>,
    context?: FileDependencyContext,
  ): FileDependencyEdge[];
  analyzeFunctionStructure(
    sourceText: string,
    span: FunctionLineSpan,
    filePath?: string,
  ): FunctionStructureMetrics;
  countControlFlowBranches(sourceText: string, filePath: string): number;
  generateCandidateMutations(
    sourceText: string,
    startLine?: number,
    endLine?: number,
    filePath?: string,
  ): PolyglotCandidateMutation[];
  defaultTestCommand(rootDir: string, associatedTestFiles: string[]): Promise<string>;
  analyzeAstEvidence(
    rootDir: string,
    sourceFiles: string[],
    testFiles: string[],
  ): Promise<PolyglotRepoAstEvidence>;
  /** Historic evidence classification when it differs from architecture discovery. */
  classifyEvidenceFile?(filePath: string): "source" | "test" | undefined;
  filterProductionLines?(
    lines: Map<number, number>,
    spans: readonly FunctionLineSpan[],
  ): void;
  extractInlineTestBlockFingerprints?(sourceText: string): Map<string, string>;
}

export function stripCodeExtension(filePath: string): string {
  return filePath.replace(/\.(tsx?|jsx?|[mc][jt]s|go|rs|java)$/, "");
}

export function countSpanControlFlowBranches(spans: PolyglotFunctionSpan[]): number {
  return spans.reduce((total, span) => total + Math.max(0, span.cyclomaticComplexity - 1), 0);
}

const CHAR_LITERAL_AFTER_QUOTE_RE =
  /^(?:\\(?:u\{[0-9a-fA-F_]+\}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|x[0-9a-fA-F]{2}|[0-7]{1,3}|[^\r\n])|[\uD800-\uDBFF][\uDC00-\uDFFF]|[^'\\\r\n])'/;

/**
 * Strips // line comments and /* block comments while preserving \n line breaks and
 * exact UTF-16 code-unit offsets (`noComments.length === masked.length === source.length`).
 * Also produces a `masked` string where string/char literals and comments are replaced
 * with spaces (preserving \n) for safe brace and keyword scanning.
 */
export function stripCommentsAndMaskStrings(source: string, language?: "rust" | "java"): {
  noComments: string;
  masked: string;
} {
  // Index strictly by UTF-16 code units (`split("")`), matching `source.length`,
  // `RegExpExecArray.index`, `buildLineStarts`, and `String.prototype.slice`.
  const noCommentsChars = source.split("");
  const maskedChars = source.split("");
  const len = source.length;
  const rustRawString = /(?:[bc])?r(#*)"/y;
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

    // Rust block comments can contain nested block comments.
    if (ch === "/" && next === "*") {
      const start = i;
      i += 2;
      let depth = 1;
      while (i < len && depth > 0) {
        if (source.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else if (language === "rust" && source.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else {
          i++;
        }
      }
      for (let at = start; at < i; at++) {
        if (source[at] === "\n") continue;
        noCommentsChars[at] = " ";
        maskedChars[at] = " ";
      }
      continue;
    }

    if (language === "rust" && (ch === "r" || ch === "b" || ch === "c") &&
        !/[\w$]/.test(source[i - 1] ?? "")) {
      rustRawString.lastIndex = i;
      const raw = rustRawString.exec(source);
      if (raw) {
        const closing = `"${raw[1]}`;
        const closeAt = source.indexOf(closing, i + raw[0].length);
        const end = closeAt === -1 ? len : closeAt + closing.length;
        for (; i < end; i++) {
          if (source[i] !== "\n") maskedChars[i] = " ";
        }
        continue;
      }
    }

    if (language === "java" && source.startsWith('"""', i)) {
      const start = i;
      i += 3;
      while (i < len && !source.startsWith('"""', i)) {
        i += source[i] === "\\" && i + 1 < len ? 2 : 1;
      }
      i = Math.min(len, i + 3);
      for (let at = start; at < i; at++) {
        if (source[at] !== "\n") maskedChars[at] = " ";
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

    // Single-quoted char/rune '...' (BMP, UTF-16 surrogate pair, or escape; never Rust lifetime `'a` / `'static`)
    if (ch === "'") {
      const charMatch = CHAR_LITERAL_AFTER_QUOTE_RE.exec(source.slice(i + 1, i + 16));
      if (charMatch) {
        const endQuoteIdx = i + charMatch[0].length;
        while (i <= endQuoteIdx) {
          maskedChars[i] = " ";
          i++;
        }
        continue;
      }
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

export function buildLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

export function offsetToLine(lineStarts: number[], offset: number): number {
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

export function countComplexityInMaskedSlice(
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

export function createEvidenceAccumulator(): {
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

export function collectOperatorMutations(params: {
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
