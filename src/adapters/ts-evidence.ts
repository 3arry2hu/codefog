import * as fs from "node:fs/promises";
import * as path from "node:path";
import ts from "typescript";
import { toPosix } from "../path-utils.js";
import { createEvidenceAccumulator, stripCodeExtension, type PolyglotRepoAstEvidence } from "./shared.js";

const LIVENESS_MATCHERS = new Set([
  "toBeDefined",
  "toBeTruthy",
  "toBeTypeOf",
  "any",
  "anything",
]);

const OUTCOME_MATCHERS = new Set([
  "toBe",
  "toEqual",
  "toStrictEqual",
  "toContain",
  "toContainEqual",
  "toMatch",
  "toMatchObject",
  "toThrow",
  "toThrowError",
  "toBeGreaterThan",
  "toBeGreaterThanOrEqual",
  "toBeLessThan",
  "toBeLessThanOrEqual",
  "toBeCloseTo",
  "toHaveLength",
  "toHaveProperty",
  "toHaveBeenCalledWith",
  "toHaveBeenLastCalledWith",
  "toHaveBeenNthCalledWith",
  "toHaveReturnedWith",
  "toBeNull",
  "toBeFalsy",
  "toBeNaN",
  "toSatisfy",
  "toMatchInlineSnapshot",
  "toMatchSnapshot",
  "equal",
  "strictEqual",
  "deepEqual",
  "deepStrictEqual",
  "notEqual",
  "notStrictEqual",
  "notDeepEqual",
  "notDeepStrictEqual",
  "match",
  "throws",
  "rejects",
  "doesNotThrow",
]);

const TEST_BLOCK_CALLEES = new Set(["it", "test"]);

interface ImportedBinding {
  localName: string;
  exportedName: string;
  targetFileStem: string | null;
}

function extractImports(sourceFile: ts.SourceFile, currentFileRel: string): Map<string, ImportedBinding> {
  const bindings = new Map<string, ImportedBinding>();
  const currentDir = path.posix.dirname(toPosix(currentFileRel));

  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue;
    const moduleSpec = ts.isStringLiteral(stmt.moduleSpecifier)
      ? stmt.moduleSpecifier.text
      : "";
    let targetFileStem: string | null = null;
    if (moduleSpec.startsWith(".")) {
      const resolved = path.posix.normalize(path.posix.join(currentDir, moduleSpec));
      targetFileStem = stripCodeExtension(resolved);
    }

    const { name, namedBindings } = stmt.importClause;
    if (name) {
      bindings.set(name.text, {
        localName: name.text,
        exportedName: "default",
        targetFileStem,
      });
    }
    if (namedBindings) {
      if (ts.isNamedImports(namedBindings)) {
        for (const el of namedBindings.elements) {
          const localName = el.name.text;
          const exportedName = el.propertyName ? el.propertyName.text : localName;
          bindings.set(localName, {
            localName,
            exportedName,
            targetFileStem,
          });
        }
      } else if (ts.isNamespaceImport(namedBindings)) {
        bindings.set(namedBindings.name.text, {
          localName: namedBindings.name.text,
          exportedName: "*",
          targetFileStem,
        });
      }
    }
  }

  return bindings;
}

interface CallTarget {
  symbol: string;
  targetFileStem: string | null;
}

function resolveExpressionSymbols(
  expr: ts.Expression,
  imports: Map<string, ImportedBinding>,
  taintedVars: Map<string, CallTarget[]>,
): CallTarget[] {
  const results: CallTarget[] = [];

  function visit(node: ts.Node): void {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      const id = node.expression.text;
      const imp = imports.get(id);
      if (imp && imp.exportedName !== "*") {
        results.push({
          symbol: imp.exportedName === "default" ? id : imp.exportedName,
          targetFileStem: imp.targetFileStem,
        });
      }
    } else if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression)) {
        const id = node.expression.text;
        const imp = imports.get(id);
        if (imp && imp.exportedName !== "*") {
          results.push({
            symbol: imp.exportedName === "default" ? id : imp.exportedName,
            targetFileStem: imp.targetFileStem,
          });
        } else if (!TEST_BLOCK_CALLEES.has(id) && id !== "expect" && id !== "describe") {
          results.push({ symbol: id, targetFileStem: null });
        }
      } else if (ts.isPropertyAccessExpression(node.expression)) {
        const obj = node.expression.expression;
        const prop = node.expression.name.text;
        if (ts.isNewExpression(obj) && ts.isIdentifier(obj.expression)) {
          const imp = imports.get(obj.expression.text);
          results.push({
            symbol: prop,
            targetFileStem: imp ? imp.targetFileStem : null,
          });
          return;
        }
        if (ts.isIdentifier(obj)) {
          const imp = imports.get(obj.text);
          if (imp) {
            results.push({ symbol: prop, targetFileStem: imp.targetFileStem });
          } else if (taintedVars.has(obj.text)) {
            for (const t of taintedVars.get(obj.text)!) {
              results.push(t);
              if (t.targetFileStem) {
                results.push({ symbol: prop, targetFileStem: t.targetFileStem });
              }
            }
          } else {
            results.push({ symbol: prop, targetFileStem: null });
          }
        }
      }
    } else if (ts.isIdentifier(node)) {
      const tainted = taintedVars.get(node.text);
      if (tainted) {
        for (const t of tainted) {
          results.push(t);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(expr);
  return results;
}

interface ExpectChainInfo {
  subject: ts.Expression;
  matcher: string;
  isNegated: boolean;
}

function parseExpectCall(node: ts.CallExpression): ExpectChainInfo | null {
  if (!ts.isPropertyAccessExpression(node.expression)) return null;
  const matcher = node.expression.name.text;
  let current: ts.Expression = node.expression.expression;
  let isNegated = false;

  while (ts.isPropertyAccessExpression(current)) {
    const modifier = current.name.text;
    if (modifier === "not") {
      isNegated = !isNegated;
    }
    current = current.expression;
  }

  if (
    ts.isCallExpression(current) &&
    ts.isIdentifier(current.expression) &&
    current.expression.text === "expect" &&
    current.arguments.length > 0
  ) {
    return {
      subject: current.arguments[0],
      matcher,
      isNegated,
    };
  }

  if (
    ts.isIdentifier(current) &&
    current.text === "assert" &&
    node.arguments.length > 0
  ) {
    return {
      subject: node.arguments[0],
      matcher,
      isNegated: false,
    };
  }

  return null;
}

export async function analyzeTsAstEvidence(
  rootDir: string,
  sourceFiles: string[],
  testFiles: string[],
): Promise<PolyglotRepoAstEvidence> {
  const { evidenceMap, getOrCreateEv } = createEvidenceAccumulator();
  const getOrCreateInternal = (targetFileStem: string | null, symbol: string) =>
    getOrCreateEv(targetFileStem ?? "*", symbol);

  for (const testFileRel of testFiles) {
    const fullPath = path.join(rootDir, testFileRel);
    let content = "";
    try {
      content = await fs.readFile(fullPath, "utf8");
    } catch {
      continue;
    }

    const sourceFile = ts.createSourceFile(
      testFileRel,
      content,
      ts.ScriptTarget.Latest,
      true,
    );
    const imports = extractImports(sourceFile, testFileRel);
    let blockCounter = 0;

    function analyzeTestBlockBody(body: ts.Node): void {
      const blockId = `${testFileRel}#${++blockCounter}`;
      const taintedVars = new Map<string, CallTarget[]>();
      const calledInBlock = new Map<string, CallTarget>();
      const outcomeAssertedInBlock = new Map<string, number>();
      const livenessCheckedInBlock = new Map<string, number>();
      let blockHasAnyOutcomeAssertion = false;

      function recordCallTarget(target: CallTarget): void {
        const key = `${target.targetFileStem ?? "*"}::${target.symbol}`;
        calledInBlock.set(key, target);
      }

      function walkBlock(node: ts.Node): void {
        if (ts.isVariableDeclaration(node) && node.initializer) {
          const targets = resolveExpressionSymbols(node.initializer, imports, taintedVars);
          if (targets.length > 0) {
            for (const t of targets) recordCallTarget(t);
            if (ts.isIdentifier(node.name)) {
              taintedVars.set(node.name.text, targets);
            } else if (ts.isObjectBindingPattern(node.name)) {
              for (const el of node.name.elements) {
                if (ts.isIdentifier(el.name)) {
                  taintedVars.set(el.name.text, targets);
                }
              }
            }
          }
        }

        if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(node.left)
        ) {
          const targets = resolveExpressionSymbols(node.right, imports, taintedVars);
          if (targets.length > 0) {
            for (const t of targets) recordCallTarget(t);
            taintedVars.set(node.left.text, targets);
          }
        }

        if (ts.isCallExpression(node)) {
          const expectInfo = parseExpectCall(node);
          if (expectInfo) {
            const isLiveness =
              LIVENESS_MATCHERS.has(expectInfo.matcher) && !expectInfo.isNegated;
            const isOutcome =
              OUTCOME_MATCHERS.has(expectInfo.matcher) ||
              (LIVENESS_MATCHERS.has(expectInfo.matcher) && expectInfo.isNegated);
            if (isOutcome) {
              blockHasAnyOutcomeAssertion = true;
            }

            const subjectTargets = resolveExpressionSymbols(
              expectInfo.subject,
              imports,
              taintedVars,
            );
            for (const t of subjectTargets) {
              recordCallTarget(t);
              const key = `${t.targetFileStem ?? "*"}::${t.symbol}`;
              if (isOutcome) {
                outcomeAssertedInBlock.set(key, (outcomeAssertedInBlock.get(key) ?? 0) + 1);
              } else if (isLiveness) {
                livenessCheckedInBlock.set(key, (livenessCheckedInBlock.get(key) ?? 0) + 1);
              }
            }
          } else {
            const directTargets = resolveExpressionSymbols(node, imports, taintedVars);
            for (const t of directTargets) {
              if (t.targetFileStem !== null) {
                recordCallTarget(t);
              }
            }
          }
        }

        ts.forEachChild(node, walkBlock);
      }

      walkBlock(body);

      for (const [key, target] of calledInBlock.entries()) {
        const evidence = getOrCreateInternal(target.targetFileStem, target.symbol);
        evidence.executedBlocks.add(blockId);
        evidence.testFiles.add(testFileRel);
        const outcomeCount = outcomeAssertedInBlock.get(key) ?? 0;
        const livenessCount = livenessCheckedInBlock.get(key) ?? 0;
        // Also support CLI-style tests where runCli(..., { stdout }) captures output into a buffer and asserts on the buffer
        const effectiveOutcome =
          outcomeCount > 0 ? outcomeCount : blockHasAnyOutcomeAssertion && calledInBlock.size === 1 && livenessCount === 0 ? 1 : 0;

        if (effectiveOutcome > 0) {
          evidence.outcomeAssertedBlocks.add(blockId);
          evidence.directOutcomeAssertions += effectiveOutcome;
        }
        if (livenessCount > 0) {
          evidence.livenessCheckedBlocks.add(blockId);
          evidence.directLivenessChecks += livenessCount;
        }
      }
    }

    function findTestBlocks(node: ts.Node): void {
      if (ts.isCallExpression(node)) {
        let calleeName: string | null = null;
        if (ts.isIdentifier(node.expression)) {
          calleeName = node.expression.text;
        } else if (
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          TEST_BLOCK_CALLEES.has(node.expression.expression.text)
        ) {
          calleeName = node.expression.expression.text;
        }
        if (calleeName && TEST_BLOCK_CALLEES.has(calleeName) && node.arguments.length >= 2) {
          const callback = node.arguments[1];
          if (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) {
            analyzeTestBlockBody(callback.body);
            return;
          }
        }
      }
      ts.forEachChild(node, findTestBlocks);
    }

    findTestBlocks(sourceFile);
  }

  const callGraph = new Map<string, Set<string>>();

  for (const srcFileRel of sourceFiles) {
    const fullPath = path.join(rootDir, srcFileRel);
    let content = "";
    try {
      content = await fs.readFile(fullPath, "utf8");
    } catch {
      continue;
    }

    const sf = ts.createSourceFile(
      srcFileRel,
      content,
      ts.ScriptTarget.Latest,
      true,
      srcFileRel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const srcStem = stripCodeExtension(toPosix(srcFileRel));
    const imports = extractImports(sf, srcFileRel);

    function collectCallsInFunction(callerSymbol: string, fnBody: ts.Node): void {
      const callerKey = `${srcStem}::${callerSymbol}`;
      let edges = callGraph.get(callerKey);
      if (!edges) {
        edges = new Set();
        callGraph.set(callerKey, edges);
      }

      function walkBody(n: ts.Node): void {
        if (ts.isCallExpression(n)) {
          if (ts.isIdentifier(n.expression)) {
            const calleeId = n.expression.text;
            const imp = imports.get(calleeId);
            if (imp && imp.targetFileStem && imp.exportedName !== "*") {
              const targetSym = imp.exportedName === "default" ? calleeId : imp.exportedName;
              edges!.add(`${imp.targetFileStem}::${targetSym}`);
            } else {
              edges!.add(`${srcStem}::${calleeId}`);
            }
          } else if (
            ts.isPropertyAccessExpression(n.expression) &&
            ts.isIdentifier(n.expression.expression)
          ) {
            const ns = imports.get(n.expression.expression.text);
            if (ns && ns.targetFileStem && ns.exportedName === "*") {
              edges!.add(`${ns.targetFileStem}::${n.expression.name.text}`);
            }
          }
        }
        ts.forEachChild(n, walkBody);
      }

      walkBody(fnBody);
    }

    function visitTopLevel(node: ts.Node): void {
      if (ts.isFunctionDeclaration(node) && node.name && node.body) {
        collectCallsInFunction(node.name.text, node.body);
        return;
      }
      if (ts.isMethodDeclaration(node) && node.name && node.body) {
        collectCallsInFunction(node.name.getText(sf), node.body);
        return;
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      ) {
        collectCallsInFunction(node.name.text, node.initializer.body);
        return;
      }
      ts.forEachChild(node, visitTopLevel);
    }

    visitTopLevel(sf);
  }

  return { evidenceEntries: [...evidenceMap.values()], callGraphEdges: callGraph };
}

/**
 * Counts TS/JS Outcome Assertions in a standalone code snippet (e.g. a Markdown code block),
 * reusing the TS/JS adapter's expect/assert matcher classification.
 * Comments (such as `// =>`) and `console.log` calls are not counted as assertions.
 */
export function countTsJsOutcomeAssertions(sourceText: string): number {
  const sf = ts.createSourceFile(
    "snippet.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let outcomeAssertions = 0;

  function hasValueComparison(expr: ts.Node): boolean {
    let found = false;
    function check(n: ts.Node): void {
      if (ts.isBinaryExpression(n)) {
        const op = n.operatorToken.kind;
        if (
          op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
          op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
          op === ts.SyntaxKind.EqualsEqualsToken ||
          op === ts.SyntaxKind.ExclamationEqualsToken ||
          op === ts.SyntaxKind.LessThanToken ||
          op === ts.SyntaxKind.LessThanEqualsToken ||
          op === ts.SyntaxKind.GreaterThanToken ||
          op === ts.SyntaxKind.GreaterThanEqualsToken
        ) {
          found = true;
          return;
        }
      }
      ts.forEachChild(n, check);
    }
    check(expr);
    return found;
  }

  function walk(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const expectInfo = parseExpectCall(node);
      if (expectInfo) {
        const isOutcome =
          OUTCOME_MATCHERS.has(expectInfo.matcher) ||
          (LIVENESS_MATCHERS.has(expectInfo.matcher) && expectInfo.isNegated);
        if (isOutcome) {
          outcomeAssertions++;
        } else if (
          expectInfo.matcher === "ok" &&
          node.arguments.length > 0 &&
          hasValueComparison(node.arguments[0]!)
        ) {
          outcomeAssertions++;
        }
      } else if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "assert" &&
        node.arguments.length > 0 &&
        hasValueComparison(node.arguments[0]!)
      ) {
        outcomeAssertions++;
      }
    }
    ts.forEachChild(node, walk);
  }

  walk(sf);
  return outcomeAssertions;
}
