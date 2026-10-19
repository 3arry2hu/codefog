import * as fs from "node:fs/promises";
import * as path from "node:path";
import ts from "typescript";

export interface FunctionAstEvidence {
  symbol: string;
  file: string;
  executedTestBlocks: number;
  assertionsOnOutcome: number;
  weakAssertionsOnly: number;
  testFiles: string[];
}

export interface RepoTestAstResult {
  testFileCount: number;
  /** Keyed by `${normalizedFilePath}::${symbol}` and fallback `*::${symbol}` */
  byFileAndSymbol: Map<string, FunctionAstEvidence>;
  bySymbol: Map<string, FunctionAstEvidence>;
}

const WEAK_MATCHERS = new Set([
  "toBeDefined",
  "toBeTruthy",
  "toBeTypeOf",
  "any",
  "anything",
]);

const STRONG_MATCHERS = new Set([
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
  "throws",
  "rejects",
  "doesNotThrow",
]);

const TEST_BLOCK_CALLEES = new Set(["it", "test"]);

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function stripCodeExtension(p: string): string {
  return p.replace(/\.(tsx?|jsx?|mjs|cjs)$/, "");
}

async function findTestFiles(dir: string, rootDir: string, out: string[] = []): Promise<string[]> {
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
      entry.name === "dist" ||
      entry.name === "coverage" ||
      entry.name === ".codefog"
    ) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await findTestFiles(fullPath, rootDir, out);
    } else if (/\.(test|spec)\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) {
      out.push(toPosix(path.relative(rootDir, fullPath)));
    }
  }
  return out;
}

interface ImportedBinding {
  localName: string;
  exportedName: string;
  targetFileStem: string | null;
}

function extractImports(sourceFile: ts.SourceFile, testFileRel: string): Map<string, ImportedBinding> {
  const bindings = new Map<string, ImportedBinding>();
  const testDir = path.posix.dirname(toPosix(testFileRel));

  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue;
    const moduleSpec = ts.isStringLiteral(stmt.moduleSpecifier)
      ? stmt.moduleSpecifier.text
      : "";
    let targetFileStem: string | null = null;
    if (moduleSpec.startsWith(".")) {
      const resolved = path.posix.normalize(path.posix.join(testDir, moduleSpec));
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
    if (ts.isCallExpression(node)) {
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
        if (ts.isIdentifier(obj)) {
          const imp = imports.get(obj.text);
          if (imp && imp.exportedName === "*") {
            results.push({ symbol: prop, targetFileStem: imp.targetFileStem });
          } else if (taintedVars.has(obj.text)) {
            for (const t of taintedVars.get(obj.text)!) {
              results.push(t);
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
  // Matches expect(subject).toBe(...) or expect(subject).not.toBe(...) or expect(subject).resolves.toBe(...)
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

  // Also support assert.equal(actual, expected) / assert.strictEqual(actual, expected)
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

export async function analyzeTestAstEvidence(rootDir: string): Promise<RepoTestAstResult> {
  const testFiles = await findTestFiles(rootDir, rootDir);
  const byFileAndSymbol = new Map<string, FunctionAstEvidence>();
  const bySymbol = new Map<string, FunctionAstEvidence>();

  function getOrCreate(targetFileStem: string | null, symbol: string): FunctionAstEvidence {
    const key = targetFileStem ? `${targetFileStem}::${symbol}` : `*::${symbol}`;
    let entry = byFileAndSymbol.get(key);
    if (!entry) {
      entry = {
        symbol,
        file: targetFileStem ?? "*",
        executedTestBlocks: 0,
        assertionsOnOutcome: 0,
        weakAssertionsOnly: 0,
        testFiles: [],
      };
      byFileAndSymbol.set(key, entry);
    }
    if (!bySymbol.has(symbol)) {
      bySymbol.set(symbol, entry);
    }
    return entry;
  }

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

    function analyzeTestBlockBody(body: ts.Node): void {
      const taintedVars = new Map<string, CallTarget[]>();
      const calledInBlock = new Map<string, CallTarget>();
      const strongAssertedInBlock = new Map<string, number>();
      const weakAssertedInBlock = new Map<string, number>();

      function recordCallTarget(target: CallTarget): void {
        const key = `${target.targetFileStem ?? "*"}::${target.symbol}`;
        calledInBlock.set(key, target);
      }

      function walkBlock(node: ts.Node): void {
        // Variable declarations: const out = formatInvoice(250);
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

        // Binary assignment: out = formatInvoice(250)
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

        // Check if this is an expect(...).matcher(...) call
        if (ts.isCallExpression(node)) {
          const expectInfo = parseExpectCall(node);
          if (expectInfo) {
            const subjectTargets = resolveExpressionSymbols(
              expectInfo.subject,
              imports,
              taintedVars,
            );
            for (const t of subjectTargets) {
              recordCallTarget(t);
              const key = `${t.targetFileStem ?? "*"}::${t.symbol}`;
              const isWeak =
                WEAK_MATCHERS.has(expectInfo.matcher) && !expectInfo.isNegated;
              const isStrong =
                STRONG_MATCHERS.has(expectInfo.matcher) ||
                (WEAK_MATCHERS.has(expectInfo.matcher) && expectInfo.isNegated);

              if (isStrong) {
                strongAssertedInBlock.set(key, (strongAssertedInBlock.get(key) ?? 0) + 1);
              } else if (isWeak) {
                weakAssertedInBlock.set(key, (weakAssertedInBlock.get(key) ?? 0) + 1);
              }
            }
          } else {
            // Standalone call expression: e.g. syncWebhook({ id: 'evt_1' })
            if (ts.isIdentifier(node.expression)) {
              const id = node.expression.text;
              const imp = imports.get(id);
              if (imp && imp.exportedName !== "*") {
                recordCallTarget({
                  symbol: imp.exportedName === "default" ? id : imp.exportedName,
                  targetFileStem: imp.targetFileStem,
                });
              }
            } else if (
              ts.isPropertyAccessExpression(node.expression) &&
              ts.isIdentifier(node.expression.expression)
            ) {
              const ns = imports.get(node.expression.expression.text);
              if (ns && ns.exportedName === "*") {
                recordCallTarget({
                  symbol: node.expression.name.text,
                  targetFileStem: ns.targetFileStem,
                });
              }
            }
          }
        }

        ts.forEachChild(node, walkBlock);
      }

      walkBlock(body);

      for (const [key, target] of calledInBlock.entries()) {
        const evidence = getOrCreate(target.targetFileStem, target.symbol);
        evidence.executedTestBlocks += 1;
        evidence.assertionsOnOutcome += strongAssertedInBlock.get(key) ?? 0;
        evidence.weakAssertionsOnly += weakAssertedInBlock.get(key) ?? 0;
        if (!evidence.testFiles.includes(testFileRel)) {
          evidence.testFiles.push(testFileRel);
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

  return {
    testFileCount: testFiles.length,
    byFileAndSymbol,
    bySymbol,
  };
}

export function lookupFunctionAstEvidence(
  astResult: RepoTestAstResult,
  sourceFileRel: string,
  symbol: string,
): FunctionAstEvidence | undefined {
  const stem = stripCodeExtension(toPosix(sourceFileRel));
  return (
    astResult.byFileAndSymbol.get(`${stem}::${symbol}`) ??
    astResult.byFileAndSymbol.get(`*::${symbol}`) ??
    astResult.bySymbol.get(symbol)
  );
}
