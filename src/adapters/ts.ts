import * as fs from "node:fs/promises";
import * as path from "node:path";
import ts from "typescript";
import { toPosix } from "../path-utils.js";
import { countTsControlFlowDecisions } from "../ts-ast-utils.js";
import { analyzeTsAstEvidence } from "./ts-evidence.js";
import type {
  FileDependencyEdge,
  FunctionStructureMetrics,
  FunctionLineSpan,
  LanguageAdapter,
  PolyglotCandidateMutation,
  PolyglotExtractedSymbol,
  PolyglotFunctionSpan,
} from "./shared.js";

let lastParsedSource: ts.SourceFile | undefined;
function parseTsSource(sourceText: string, filePath: string): ts.SourceFile {
  if (lastParsedSource?.fileName === filePath && lastParsedSource.text === sourceText) return lastParsedSource;
  lastParsedSource = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  return lastParsedSource;
}

function extractTsFunctionSpans(sourceText: string, fileName: string): PolyglotFunctionSpan[] {
  const file = parseTsSource(sourceText, fileName);
  const spans: PolyglotFunctionSpan[] = [];
  const fingerprints = extractTsRuntimeFingerprints(sourceText, fileName, file);
  visitNamedTsFunctions(file, (name, declaration, fn) => {
    spans.push({
      name,
      startLine: file.getLineAndCharacterOfPosition(declaration.getStart(file)).line + 1,
      endLine: file.getLineAndCharacterOfPosition(declaration.end).line + 1,
      cyclomaticComplexity: 1 + countTsControlFlowDecisions(fn),
      returnSignature: fn.type?.getText(file) ?? "",
      runtimeFingerprint: fingerprints.get(name) ?? "",
    });
  });
  return spans.sort((a, b) => a.startLine - b.startLine);
}

/**
 * Extracts a canonical runtime AST fingerprint for each function/method in a TypeScript file.
 * Strips all comments, whitespace, type annotations, interfaces, and type aliases so that
 * pure formatting, comment, or type-only edits produce the exact same fingerprint.
 */
function extractTsRuntimeFingerprints(
  sourceText: string,
  fileName: string,
  sourceFile?: ts.SourceFile,
): Map<string, string> {
  const sf = sourceFile ?? parseTsSource(sourceText, fileName);

  const fingerprints = new Map<string, string>();

  function serializeRuntimeNode(node: ts.Node): string {
    // Ignore purely type-level constructs
    if (
      ts.isTypeNode(node) ||
      ts.isTypeParameterDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node)
    ) {
      return "";
    }

    // For TypeAssertion / AsExpression / SatisfiesExpression, only serialize the inner runtime expression
    if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node)) {
      return serializeRuntimeNode(node.expression);
    }

    // For ParameterDeclaration, keep parameter name and initializer (runtime default), skip type annotation
    if (ts.isParameter(node)) {
      const nameStr = serializeRuntimeNode(node.name);
      const initStr = node.initializer ? `=${serializeRuntimeNode(node.initializer)}` : "";
      const dotDotDot = node.dotDotDotToken ? "..." : "";
      return `${dotDotDot}${nameStr}${initStr}`;
    }

    // For VariableDeclaration, keep name and initializer, skip type annotation
    if (ts.isVariableDeclaration(node)) {
      const nameStr = serializeRuntimeNode(node.name);
      const initStr = node.initializer ? `=${serializeRuntimeNode(node.initializer)}` : "";
      return `Var(${nameStr}${initStr})`;
    }

    if (ts.isIdentifier(node)) {
      return `id:${node.text}`;
    }
    if (
      ts.isNumericLiteral(node) ||
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isRegularExpressionLiteral(node)
    ) {
      return `lit:${node.text}`;
    }
    if (node.kind === ts.SyntaxKind.TrueKeyword) return "lit:true";
    if (node.kind === ts.SyntaxKind.FalseKeyword) return "lit:false";
    if (node.kind === ts.SyntaxKind.NullKeyword) return "lit:null";

    if (ts.isBinaryExpression(node)) {
      const op = ts.tokenToString(node.operatorToken.kind) ?? String(node.operatorToken.kind);
      return `Bin(${serializeRuntimeNode(node.left)},${op},${serializeRuntimeNode(node.right)})`;
    }
    if (ts.isPrefixUnaryExpression(node)) {
      const op = ts.tokenToString(node.operator) ?? String(node.operator);
      return `Pre(${op},${serializeRuntimeNode(node.operand)})`;
    }
    if (ts.isPostfixUnaryExpression(node)) {
      const op = ts.tokenToString(node.operator) ?? String(node.operator);
      return `Post(${serializeRuntimeNode(node.operand)},${op})`;
    }

    const childParts: string[] = [];
    ts.forEachChild(node, (child) => {
      // Skip modifier tokens (export, async, public, etc.) except async which affects runtime
      if (ts.canHaveModifiers(node)) {
        const modifiers = ts.getModifiers(node);
        if (modifiers && modifiers.includes(child as ts.Modifier)) {
          if (child.kind === ts.SyntaxKind.AsyncKeyword) {
            childParts.push("async");
          }
          return;
        }
      }
      const serialized = serializeRuntimeNode(child);
      if (serialized) {
        childParts.push(serialized);
      }
    });

    return `${ts.SyntaxKind[node.kind]}(${childParts.join(",")})`;
  }

  function recordFunction(
    name: string,
    params: ts.NodeArray<ts.ParameterDeclaration>,
    body: ts.Node | undefined,
  ): void {
    if (!body) return;
    const paramSig = params.map((p) => serializeRuntimeNode(p)).join(",");
    const bodySig = serializeRuntimeNode(body);
    fingerprints.set(name, `fn(${paramSig}){${bodySig}}`);
  }

  visitNamedTsFunctions(sf, (name, _declaration, fn) => {
    recordFunction(name, fn.parameters, fn.body);
  });
  return fingerprints;
}

function extractTsSymbols(sourceText: string, filePath: string): PolyglotExtractedSymbol[] {
  const relPath = toPosix(filePath);
  const symbols: PolyglotExtractedSymbol[] = [];
  const sf = parseTsSource(sourceText, relPath);
  const fnFingerprints = extractTsRuntimeFingerprints(sourceText, relPath, sf);

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

function generateTsCandidateMutations(
  sourceText: string,
  startLine?: number,
  endLine?: number,
  fileName = "file.ts",
): PolyglotCandidateMutation[] {
  const sf = parseTsSource(sourceText, fileName);

  const candidates: PolyglotCandidateMutation[] = [];
  let seq = 1;

  function inLineRange(node: ts.Node): { ok: boolean; line: number } {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    if (startLine !== undefined && line < startLine) return { ok: false, line };
    if (endLine !== undefined && line > endLine) return { ok: false, line };
    return { ok: true, line };
  }

  function addReplacement(node: ts.Node, replacement: string, line: number): void {
    const start = node.getStart(sf);
    const end = node.getEnd();
    const original = sourceText.slice(start, end);
    if (original === replacement) return;
    const mutatedSource = sourceText.slice(0, start) + replacement + sourceText.slice(end);
    candidates.push({
      id: `mut_${seq++}`,
      line,
      original,
      mutated: replacement,
      mutatedSource,
    });
  }

  const binaryMutatorMap: Partial<Record<ts.SyntaxKind, string[]>> = {
    [ts.SyntaxKind.GreaterThanEqualsToken]: [">", "<"],
    [ts.SyntaxKind.LessThanEqualsToken]: ["<", ">"],
    [ts.SyntaxKind.GreaterThanToken]: [">=", "<="],
    [ts.SyntaxKind.LessThanToken]: ["<=", ">="],
    [ts.SyntaxKind.EqualsEqualsEqualsToken]: ["!=="],
    [ts.SyntaxKind.ExclamationEqualsEqualsToken]: ["==="],
    [ts.SyntaxKind.EqualsEqualsToken]: ["!="],
    [ts.SyntaxKind.ExclamationEqualsToken]: ["=="],
    [ts.SyntaxKind.PlusToken]: ["-"],
    [ts.SyntaxKind.MinusToken]: ["+"],
    [ts.SyntaxKind.AsteriskToken]: ["/"],
    [ts.SyntaxKind.SlashToken]: ["*"],
    [ts.SyntaxKind.AmpersandAmpersandToken]: ["||"],
    [ts.SyntaxKind.BarBarToken]: ["&&"],
  };

  function visit(node: ts.Node): void {
    const { ok, line } = inLineRange(node);
    if (ok) {
      if (ts.isBinaryExpression(node)) {
        const replacements = binaryMutatorMap[node.operatorToken.kind];
        if (replacements) {
          const leftText = node.left.getText(sf);
          const rightText = node.right.getText(sf);
          for (const op of replacements) {
            addReplacement(node, `${leftText} ${op} ${rightText}`, line);
          }
        }
      } else if (node.kind === ts.SyntaxKind.TrueKeyword) {
        addReplacement(node, "false", line);
      } else if (node.kind === ts.SyntaxKind.FalseKeyword) {
        addReplacement(node, "true", line);
      } else if (
        (ts.isFunctionDeclaration(node) ||
          ts.isMethodDeclaration(node) ||
          ts.isArrowFunction(node) ||
          ts.isFunctionExpression(node)) &&
        node.body
      ) {
        // Method/function body clearance check (Pseudo-tested method detector)
        const bodyLine = sf.getLineAndCharacterOfPosition(node.body.getStart(sf)).line + 1;
        if (ts.isBlock(node.body) && node.body.statements.length > 0) {
          addReplacement(node.body, "{ return undefined as any; }", bodyLine);
        } else if (!ts.isBlock(node.body)) {
          addReplacement(node.body, "(undefined as any)", bodyLine);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return candidates;
}

async function defaultTsTestCommand(
  rootDir: string,
  associatedTestFiles: string[],
): Promise<string> {
  const testTargets = associatedTestFiles.length > 0 ? ` ${associatedTestFiles.join(" ")}` : "";
  try {
    const pkgRaw = await fs.readFile(path.join(rootDir, "package.json"), "utf8");
    const pkg = JSON.parse(pkgRaw) as {
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.vitest || pkg.scripts?.test?.includes("vitest")) {
      return `npx vitest run${testTargets}`;
    }
    if (deps.jest || pkg.scripts?.test?.includes("jest")) {
      return `npx jest${testTargets}`;
    }
  } catch {
    // Fallback below
  }
  return `node --test${testTargets}`;
}

const TS_SOURCE_EXTENSION = /\.(?:tsx?|jsx?|[mc][jt]s)$/;
const TS_TEST_SUFFIX = /\.(?:test|spec)\.(?:tsx?|jsx?|[mc][jt]s)$/;
const TS_HISTORIC_EVIDENCE_EXTENSION = /\.(?:tsx?|jsx?|mjs)$/;
const TS_RESOLUTION_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".d.ts"];
const TS_EXTENSION_ALIASES: Record<string, string[]> = {
  ".js": [".ts", ".tsx", ".d.ts"],
  ".jsx": [".tsx"],
  ".mjs": [".mts", ".d.mts"],
  ".cjs": [".cts", ".d.cts"],
};

function isTsTestFile(filePath: string): boolean {
  return TS_SOURCE_EXTENSION.test(filePath) &&
    (TS_TEST_SUFFIX.test(filePath) || /(?:^|\/)tests?\//.test(toPosix(filePath)));
}

function resolveRelativeTsImport(specifier: string, filePath: string, repoFiles: ReadonlySet<string>): string | undefined {
  if (!/^\.{1,2}\//.test(specifier)) return undefined;
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(filePath), specifier));
  const extension = path.posix.extname(target);
  return [
    target,
    ...(TS_EXTENSION_ALIASES[extension] ?? []).map((ext) => target.slice(0, -extension.length) + ext),
    ...TS_RESOLUTION_EXTENSIONS.map((ext) => target + ext),
    ...TS_RESOLUTION_EXTENSIONS.map((ext) => path.posix.join(target, "index" + ext)),
  ].find((candidate) => TS_SOURCE_EXTENSION.test(candidate) && repoFiles.has(candidate));
}

function tsFileDependencies(
  sourceText: string,
  inputPath: string,
  repoFiles: ReadonlySet<string>,
): FileDependencyEdge[] {
  const from = toPosix(inputPath);
  const sourceFile = parseTsSource(sourceText, from);
  const edges = new Map<string, FileDependencyEdge>();

  function visit(node: ts.Node): void {
    let specifier: ts.Expression | undefined;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      specifier = node.moduleSpecifier;
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      specifier = node.moduleReference.expression;
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments.length === 1
    ) {
      specifier = node.arguments[0];
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      specifier = node.argument.literal;
    }
    if (specifier && ts.isStringLiteralLike(specifier)) {
      const to = resolveRelativeTsImport(specifier.text, from, repoFiles);
      if (to && to !== from && !edges.has(to)) {
        const line = sourceFile.getLineAndCharacterOfPosition(specifier.getStart(sourceFile)).line + 1;
        edges.set(to, { from, to, line });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return [...edges.values()];
}

type TsFunctionWithBody = ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression;

function visitNamedTsFunctions(
  sourceFile: ts.SourceFile,
  callback: (name: string, declaration: ts.Node, fn: TsFunctionWithBody) => void,
): void {
  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name) {
      callback(node.name.text, node, node);
      return;
    }
    if (ts.isMethodDeclaration(node) && node.name) {
      callback(node.name.getText(sourceFile), node, node);
      return;
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      callback(node.name.text, node, node.initializer);
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

let lastStructureFile: ts.SourceFile | undefined;
let lastStructureFunctions: Map<string, Array<{ name: string; fn: TsFunctionWithBody }>> | undefined;

function tsFunctionStructure(
  sourceText: string,
  span: FunctionLineSpan,
  filePath = "file.ts",
): FunctionStructureMetrics {
  const sourceFile = parseTsSource(sourceText, filePath);
  const metrics: FunctionStructureMetrics = {
    cognitiveComplexity: 0,
    maxNestingDepth: 0,
    errorMaskingLines: [],
  };
  const lineAt = (pos: number) => sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
  if (sourceFile !== lastStructureFile || !lastStructureFunctions) {
    const functions = new Map<string, Array<{ name: string; fn: TsFunctionWithBody }>>();
    visitNamedTsFunctions(sourceFile, (name, declaration, fn) => {
      const key = `${lineAt(declaration.getStart(sourceFile))}:${lineAt(declaration.getEnd())}`;
      const candidates = functions.get(key) ?? [];
      candidates.push({ name, fn });
      functions.set(key, candidates);
    });
    lastStructureFile = sourceFile;
    lastStructureFunctions = functions;
  }
  const candidates = lastStructureFunctions.get(`${span.startLine}:${span.endLine}`);
  const selected = span.name === undefined ? candidates?.[0] : candidates?.find(({ name }) => name === span.name);
  const maskLines = new Set<number>();
  let recursive = false;

  function addBranch(depth: number, hybrid = false): void {
    metrics.cognitiveComplexity += hybrid ? 1 : 1 + depth;
    metrics.maxNestingDepth = Math.max(metrics.maxNestingDepth, depth + 1);
  }

  function isLogical(node: ts.Node): node is ts.BinaryExpression {
    return ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken);
  }

  function visit(node: ts.Node, depth: number): void {
    if (!selected && (lineAt(node.end) < span.startLine || lineAt(node.getStart(sourceFile)) > span.endLine)) {
      return;
    }
    if (ts.isIfStatement(node)) {
      visitIf(node, depth);
      return;
    }
    if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) ||
        ts.isWhileStatement(node) || ts.isDoStatement(node)) {
      addBranch(depth);
      ts.forEachChild(node, (child) => visit(child, child === node.statement ? depth + 1 : depth));
      return;
    }
    if (ts.isSwitchStatement(node)) {
      addBranch(depth);
      visit(node.expression, depth);
      visit(node.caseBlock, depth + 1);
      return;
    }
    if (ts.isConditionalExpression(node)) {
      addBranch(depth);
      visit(node.condition, depth);
      visit(node.whenTrue, depth + 1);
      visit(node.whenFalse, depth + 1);
      return;
    }
    if (ts.isCatchClause(node)) {
      addBranch(depth);
      if (node.block.statements.every(ts.isEmptyStatement)) maskLines.add(lineAt(node.getStart(sourceFile)));
      visit(node.block, depth + 1);
      return;
    }
    if (isLogical(node)) {
      let lastOperator: ts.SyntaxKind | undefined;
      function walkChain(operand: ts.Node): void {
        if (ts.isParenthesizedExpression(operand)) {
          walkChain(operand.expression);
        } else if (isLogical(operand)) {
          walkChain(operand.left);
          if (lastOperator !== operand.operatorToken.kind) metrics.cognitiveComplexity++;
          lastOperator = operand.operatorToken.kind;
          walkChain(operand.right);
        } else {
          visit(operand, depth);
        }
      }
      walkChain(node);
      return;
    }
    if ((ts.isBreakStatement(node) || ts.isContinueStatement(node)) && node.label) {
      metrics.cognitiveComplexity++;
    }
    if (!recursive && selected && ts.isCallExpression(node)) {
      const called = node.expression;
      if ((ts.isIdentifier(called) && called.text === selected.name) ||
          (ts.isMethodDeclaration(selected.fn) && ts.isPropertyAccessExpression(called) &&
            called.expression.kind === ts.SyntaxKind.ThisKeyword && called.name.text === selected.name)) {
        recursive = true;
        metrics.cognitiveComplexity++;
      }
    }
    const childDepth = ts.isFunctionLike(node) ? depth + 1 : depth;
    ts.forEachChild(node, (child) => visit(child, childDepth));
  }

  function visitIf(node: ts.IfStatement, depth: number, elseIf = false): void {
    addBranch(depth, elseIf);
    visit(node.expression, depth);
    visit(node.thenStatement, depth + 1);
    if (!node.elseStatement) return;
    if (ts.isIfStatement(node.elseStatement)) {
      visitIf(node.elseStatement, depth, true);
    } else {
      addBranch(depth, true);
      visit(node.elseStatement, depth + 1);
    }
  }

  if (selected) {
    if (selected.fn.body) visit(selected.fn.body, 0);
  } else {
    ts.forEachChild(sourceFile, (node) => {
      if (ts.isFunctionDeclaration(node) && node.body) visit(node.body, 0);
      else visit(node, 0);
    });
  }
  metrics.errorMaskingLines = [...maskLines].sort((a, b) => a - b);
  return metrics;
}

export const tsLanguageAdapter: LanguageAdapter = {
  id: "ts",
  isSourceFile: (filePath) => TS_SOURCE_EXTENSION.test(filePath) && !/\.d\.[mc]?ts$/.test(filePath) && !isTsTestFile(filePath),
  isTestFile: isTsTestFile,
  classifyEvidenceFile: (filePath) => {
    if (!TS_HISTORIC_EVIDENCE_EXTENSION.test(filePath) || filePath.endsWith(".d.ts")) return undefined;
    return TS_TEST_SUFFIX.test(filePath) ? "test" : "source";
  },
  extractFunctionSpans: extractTsFunctionSpans,
  extractSymbols: extractTsSymbols,
  extractRuntimeFingerprints: extractTsRuntimeFingerprints,
  generateCandidateMutations: generateTsCandidateMutations,
  countControlFlowBranches: (sourceText, filePath) => countTsControlFlowDecisions(parseTsSource(sourceText, filePath)),
  defaultTestCommand: defaultTsTestCommand,
  analyzeAstEvidence: analyzeTsAstEvidence,
  extractFileDependencies: tsFileDependencies,
  analyzeFunctionStructure: tsFunctionStructure,
};
