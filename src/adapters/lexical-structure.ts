import {
  buildLineStarts,
  offsetToLine,
  stripCommentsAndMaskStrings,
  type FunctionLineSpan,
  type FunctionStructureMetrics,
} from "./shared.js";

type LexicalLanguage = "go" | "rust" | "java";
type OffsetRange = { start: number; end: number };
type Token = { text: string; offset: number };

const CONTROL_KEYWORDS: Record<LexicalLanguage, Set<string>> = {
  go: new Set(["if", "for", "switch", "select"]),
  rust: new Set(["if", "for", "while", "loop", "match"]),
  java: new Set(["if", "for", "while", "switch", "catch", "do"]),
};

let lastSource: string | undefined;
let lastLanguage: LexicalLanguage | undefined;
let lastMasked = "";
let lastLineStarts: number[] = [];
let lastRustTestRanges: OffsetRange[] | undefined;

export function analyzeLexicalFunctionStructure(
  sourceText: string,
  span: FunctionLineSpan,
  language: LexicalLanguage,
  ignoredRanges?: (maskedText: string) => OffsetRange[],
  isTestFile = false,
): FunctionStructureMetrics {
  if (sourceText !== lastSource || language !== lastLanguage) {
    lastSource = sourceText;
    lastLanguage = language;
    lastMasked = stripCommentsAndMaskStrings(sourceText, language === "go" ? undefined : language).masked;
    lastLineStarts = buildLineStarts(sourceText);
    lastRustTestRanges = undefined;
  }
  const startOffset = lastLineStarts[span.startLine - 1] ?? sourceText.length;
  const endOffset = lastLineStarts[span.endLine] ?? sourceText.length;
  let text = lastMasked.slice(startOffset, endOffset);
  if (ignoredRanges) {
    lastRustTestRanges ??= ignoredRanges(lastMasked);
    for (const range of lastRustTestRanges) {
      if (range.end <= startOffset || range.start >= endOffset) continue;
      const start = Math.max(0, range.start - startOffset);
      const end = Math.min(text.length, range.end - startOffset);
      text = text.slice(0, start) + text.slice(start, end).replace(/[^\n]/g, " ") + text.slice(end);
    }
  }
  const lineAt = (offset: number) => offsetToLine(lastLineStarts, startOffset + offset);
  const maskingPattern =
    language === "go" ? /\b_\s*=\s*err\b(?=[ \t\r]*(?:[;\n}]|$))|\bif\s+err\s*!=\s*nil\s*\{\s*\}/g :
    language === "rust" ? /\.\s*(?:unwrap|expect)\s*\(/g :
    /\bcatch\s*\([^)]*\)\s*\{[;\s]*\}/g;
  const errorMaskingLines = isTestFile
    ? []
    : [...new Set([...text.matchAll(maskingPattern)].map((match) => lineAt(match.index)))];

  const tokens: Token[] = [];
  const delimiters = new Map<number, number>();
  const stack: Array<{ text: string; index: number }> = [];
  const closes: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  for (const match of text.matchAll(/[A-Za-z_$][\w$]*|&&|\|\||::|=>|->|[^\s]/g)) {
    const value = match[0];
    const index = tokens.length;
    tokens.push({ text: value, offset: match.index });
    if (value === "(" || value === "[" || value === "{") {
      stack.push({ text: value, index });
    } else if (closes[value] === stack[stack.length - 1]?.text && closes[value]) {
      delimiters.set(stack.pop()!.index, index);
    }
  }

  let cognitiveComplexity = 0;
  let maxNestingDepth = 0;
  const token = (index: number) => tokens[index]?.text;
  const isControl = (index: number) => {
    const value = token(index);
    return value !== undefined && CONTROL_KEYWORDS[language].has(value) &&
      token(index - 1) !== "." && token(index - 1) !== "::" && token(index - 1) !== "#" &&
      token(index + 1) !== "!";
  };

  function addBranch(depth: number, hybrid = false): void {
    cognitiveComplexity += hybrid ? 1 : 1 + depth;
    maxNestingDepth = Math.max(maxNestingDepth, depth + 1);
  }

  function findBody(index: number, limit: number): number {
    const keyword = token(index);
    if (keyword === "else" || keyword === "do") return index + 1;
    if (language === "java" && token(index + 1) === "(") {
      return (delimiters.get(index + 1) ?? limit - 1) + 1;
    }
    for (let i = index + 1; i < limit; i++) {
      if (token(i) === "{") {
        const close = delimiters.get(i);
        if (close === undefined || !["[", "."].includes(token(close + 1) ?? "")) return i;
      }
      i = delimiters.get(i) ?? i;
    }
    return limit;
  }

  function statementEnd(start: number, limit: number): number {
    if (start >= limit) return limit;
    if (token(start) === "{") return (delimiters.get(start) ?? limit - 1) + 1;
    if (isControl(start)) {
      const end = statementEnd(findBody(start, limit), limit);
      return token(start) === "if" && token(end) === "else"
        ? statementEnd(end + 1, limit) : end;
    }
    for (let i = start; i < limit; i++) {
      if (token(i) === ";") return i + 1;
      i = delimiters.get(i) ?? i;
    }
    return limit;
  }

  function visitBody(start: number, limit: number, depth: number): number {
    const end = statementEnd(start, limit);
    if (token(start) === "{") visit(start + 1, end - 1, depth);
    else visit(start, end, depth);
    return end;
  }

  function visitControl(start: number, limit: number, depth: number, hybrid = false): number {
    const body = findBody(start, limit);
    if (body >= limit) return start + 1;
    addBranch(depth, hybrid);
    visit(start + 1, body, depth);
    const end = visitBody(body, limit, depth + 1);
    if (token(start) === "do" && token(end) === "while" && token(end + 1) === "(") {
      const afterCondition = (delimiters.get(end + 1) ?? end + 1) + 1;
      visit(end + 1, afterCondition, depth);
      return afterCondition;
    }
    if (token(start) !== "if" || token(end) !== "else") return end;
    if (token(end + 1) === "if") return visitControl(end + 1, limit, depth, true);
    addBranch(depth, true);
    return visitBody(end + 1, limit, depth + 1);
  }

  function javaTernaryEnd(start: number, limit: number): number | undefined {
    let conditionalCount = 0;
    for (let i = start; i < limit; i++) {
      if (token(i) === "?") conditionalCount++;
      if (token(i) === ":" && --conditionalCount === 0) return i;
      if (token(i) === ";" || token(i) === "," || token(i) === "}") break;
      i = delimiters.get(i) ?? i;
    }
    return undefined;
  }

  function visit(start: number, limit: number, depth: number, preceding?: string): string | undefined {
    let logicalOperator = preceding;
    let javaSwitchArm = false;
    for (let i = start; i < limit; i++) {
      const value = token(i);
      if (language === "java" && (value === "case" || value === "default")) javaSwitchArm = true;
      if (language === "java" && value === ":") javaSwitchArm = false;
      if (isControl(i)) {
        i = visitControl(i, limit, depth) - 1;
        logicalOperator = undefined;
        continue;
      }
      if (language === "java" && value === "?") {
        const colon = javaTernaryEnd(i, limit);
        if (colon !== undefined) {
          addBranch(depth);
          visit(i + 1, colon, depth + 1);
          let end = colon + 1;
          while (end < limit && ![";", ","].includes(token(end) ?? "")) {
            end = (delimiters.get(end) ?? end) + 1;
          }
          visit(colon + 1, end, depth + 1);
          i = end - 1;
          continue;
        }
      }
      const close = delimiters.get(i);
      if (close !== undefined && close < limit) {
        if (value === "(" && token(i - 1) !== "!") {
          const followsOperator = token(i - 1) === "&&" || token(i - 1) === "||";
          const precedesOperator = token(close + 1) === "&&" || token(close + 1) === "||";
          const result = visit(i + 1, close, depth, followsOperator ? logicalOperator : undefined);
          if (precedesOperator) logicalOperator = result ?? logicalOperator;
        } else {
          const bodyDepth = language === "java" && !javaSwitchArm && value === "{" && token(i - 1) === "->"
            ? depth + 1 : depth;
          visit(i + 1, close, bodyDepth);
        }
        if (token(i - 1) === "->") javaSwitchArm = false;
        i = close;
        continue;
      }
      if (value === "&&" || value === "||") {
        if (value !== logicalOperator) cognitiveComplexity++;
        logicalOperator = value;
      } else if (value === ";" || value === "," || value === "=" ||
                 (i > start && /\n/.test(text.slice(tokens[i - 1]!.offset, tokens[i]!.offset)) &&
                   token(i - 1) !== "&&" && token(i - 1) !== "||")) {
        logicalOperator = undefined;
      }
      if (value === "break" || value === "continue" || value === "goto") {
        const next = tokens[i + 1];
        const sameLine = next && lineAt(next.offset) === lineAt(tokens[i]!.offset);
        if (sameLine && (language === "rust" ? next.text === "'" : /^[A-Za-z_$]/.test(next.text))) {
          cognitiveComplexity++;
        }
      }
    }
    return logicalOperator;
  }

  visit(0, tokens.length, 0);
  if (span.name && tokens.some(({ text: value }, i) =>
    value === span.name && token(i + 1) === "(" && token(i - 1) !== "fn" &&
    token(i - 1) !== "func" && token(i - 1) !== "." && token(i - 1) !== "::" &&
    tokens.slice(0, i).some((previous) => previous.text === "{"),
  )) {
    cognitiveComplexity++;
  }
  return { cognitiveComplexity, maxNestingDepth, errorMaskingLines };
}
