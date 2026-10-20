import * as fs from "node:fs/promises";
import * as path from "node:path";
import ts from "typescript";
import {
  POLYGLOT_LANGUAGE_ADAPTERS,
  isPolyglotSourceFile,
  isPolyglotTestFile,
} from "./polyglot.js";

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

  const IGNORED_DIRS = new Set([
    "node_modules",
    ".git",
    "vendor",
    "dist",
    "coverage",
    ".codefog",
    "target",
    "build",
    ".idea",
    ".vscode",
    ".gradle",
  ]);

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function stripCodeExtension(p: string): string {
  return p.replace(/\.(tsx?|jsx?|mjs|cjs|go|rs|java)$/, "");
}

function isTestFileName(name: string): boolean {
  return /\.(test|spec)\.(ts|tsx|js|jsx|mjs)$/.test(name) || isPolyglotTestFile(name);
}

function isSourceFileName(name: string): boolean {
  return (
    (/\.(ts|tsx|js|jsx|mjs)$/.test(name) && !name.endsWith(".d.ts") && !isTestFileName(name)) ||
    isPolyglotSourceFile(name)
  );
}

async function scanRepoFiles(
  dir: string,
  rootDir: string,
  out: { testFiles: string[]; sourceFiles: string[] } = { testFiles: [], sourceFiles: [] },
): Promise<{ testFiles: string[]; sourceFiles: string[] }> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await scanRepoFiles(fullPath, rootDir, out);
    } else {
      const relEntryPath = toPosix(path.relative(rootDir, fullPath));
      if (isTestFileName(relEntryPath)) {
        out.testFiles.push(relEntryPath);
      } else if (isSourceFileName(relEntryPath)) {
        out.sourceFiles.push(relEntryPath);
      }
    }
  }
  return out;
}

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

interface InternalEvidenceSets {
  symbol: string;
  fileStem: string;
  executedBlocks: Set<string>;
  strongAssertedBlocks: Set<string>;
  weakAssertedBlocks: Set<string>;
  directStrongAssertions: number;
  directWeakAssertions: number;
  testFiles: Set<string>;
}

export async function analyzeTestAstEvidence(rootDir: string): Promise<RepoTestAstResult> {
  const { testFiles, sourceFiles } = await scanRepoFiles(rootDir, rootDir);
  const internalMap = new Map<string, InternalEvidenceSets>();
  const bySymbolInternal = new Map<string, InternalEvidenceSets>();

  function getOrCreateInternal(targetFileStem: string | null, symbol: string): InternalEvidenceSets {
    const fileStem = targetFileStem ?? "*";
    const key = `${fileStem}::${symbol}`;
    let entry = internalMap.get(key);
    if (!entry) {
      entry = {
        symbol,
        fileStem,
        executedBlocks: new Set(),
        strongAssertedBlocks: new Set(),
        weakAssertedBlocks: new Set(),
        directStrongAssertions: 0,
        directWeakAssertions: 0,
        testFiles: new Set(),
      };
      internalMap.set(key, entry);
    }
    if (!bySymbolInternal.has(symbol)) {
      bySymbolInternal.set(symbol, entry);
    }
    return entry;
  }

  for (const testFileRel of testFiles) {
    if (isPolyglotTestFile(testFileRel)) {
      continue;
    }
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
      const strongAssertedInBlock = new Map<string, number>();
      const weakAssertedInBlock = new Map<string, number>();
      let blockHasAnyStrongAssertion = false;

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
            const isWeak =
              WEAK_MATCHERS.has(expectInfo.matcher) && !expectInfo.isNegated;
            const isStrong =
              STRONG_MATCHERS.has(expectInfo.matcher) ||
              (WEAK_MATCHERS.has(expectInfo.matcher) && expectInfo.isNegated);
            if (isStrong) {
              blockHasAnyStrongAssertion = true;
            }

            const subjectTargets = resolveExpressionSymbols(
              expectInfo.subject,
              imports,
              taintedVars,
            );
            for (const t of subjectTargets) {
              recordCallTarget(t);
              const key = `${t.targetFileStem ?? "*"}::${t.symbol}`;
              if (isStrong) {
                strongAssertedInBlock.set(key, (strongAssertedInBlock.get(key) ?? 0) + 1);
              } else if (isWeak) {
                weakAssertedInBlock.set(key, (weakAssertedInBlock.get(key) ?? 0) + 1);
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
        const strongCount = strongAssertedInBlock.get(key) ?? 0;
        const weakCount = weakAssertedInBlock.get(key) ?? 0;
        // Also support CLI-style tests where runCli(..., { stdout }) captures output into a buffer and asserts on the buffer
        const effectiveStrong =
          strongCount > 0 ? strongCount : blockHasAnyStrongAssertion && calledInBlock.size === 1 && weakCount === 0 ? 1 : 0;

        if (effectiveStrong > 0) {
          evidence.strongAssertedBlocks.add(blockId);
          evidence.directStrongAssertions += effectiveStrong;
        }
        if (weakCount > 0) {
          evidence.weakAssertedBlocks.add(blockId);
          evidence.directWeakAssertions += weakCount;
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

  // Build static call graph across source files and propagate test & assertion evidence
  const callGraph = new Map<string, Set<string>>();

  for (const adapter of POLYGLOT_LANGUAGE_ADAPTERS) {
    const langSourceFiles = sourceFiles.filter((f) => adapter.isSourceFile(f));
    const langTestFiles = testFiles.filter((f) => adapter.isTestFile(f));
    if (langSourceFiles.length === 0 && langTestFiles.length === 0) continue;

    const polyRes = await adapter.analyzeAstEvidence(rootDir, langSourceFiles, langTestFiles);
    for (const ev of polyRes.evidenceEntries) {
      const target = getOrCreateInternal(ev.fileStem, ev.symbol);
      for (const b of ev.executedBlocks) target.executedBlocks.add(b);
      for (const ob of ev.outcomeAssertedBlocks) target.strongAssertedBlocks.add(ob);
      for (const lb of ev.livenessCheckedBlocks) target.weakAssertedBlocks.add(lb);
      target.directStrongAssertions += ev.directOutcomeAssertions;
      target.directWeakAssertions += ev.directLivenessChecks;
      for (const tf of ev.testFiles) target.testFiles.add(tf);
    }
    for (const [callerKey, edges] of polyRes.callGraphEdges.entries()) {
      const existing = callGraph.get(callerKey) ?? new Set<string>();
      for (const edge of edges) existing.add(edge);
      callGraph.set(callerKey, existing);
    }
  }

  for (const srcFileRel of sourceFiles) {
    if (isPolyglotSourceFile(srcFileRel)) {
      continue;
    }
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

  // Fixed-point propagation along callGraph edges
  let changed = true;
  let iterations = 0;
  while (changed && iterations < 20) {
    changed = false;
    iterations++;
    for (const [callerKey, callees] of callGraph.entries()) {
      const [callerStem, callerSym] = callerKey.split("::");
      const callerEv =
        internalMap.get(callerKey) ??
        internalMap.get(`*::${callerSym}`) ??
        (callerSym ? bySymbolInternal.get(callerSym) : undefined);

      if (!callerEv || callerEv.executedBlocks.size === 0) continue;

      for (const calleeKey of callees) {
        const [calleeStem, calleeSym] = calleeKey.split("::");
        if (!calleeSym) continue;
        const calleeEv = getOrCreateInternal(calleeStem ?? null, calleeSym);

        for (const blk of callerEv.executedBlocks) {
          if (!calleeEv.executedBlocks.has(blk)) {
            calleeEv.executedBlocks.add(blk);
            changed = true;
          }
        }
        for (const blk of callerEv.strongAssertedBlocks) {
          if (!calleeEv.strongAssertedBlocks.has(blk)) {
            calleeEv.strongAssertedBlocks.add(blk);
            changed = true;
          }
        }
        for (const blk of callerEv.weakAssertedBlocks) {
          if (!calleeEv.weakAssertedBlocks.has(blk)) {
            calleeEv.weakAssertedBlocks.add(blk);
            changed = true;
          }
        }
        for (const tf of callerEv.testFiles) {
          if (!calleeEv.testFiles.has(tf)) {
            calleeEv.testFiles.add(tf);
            changed = true;
          }
        }
      }
    }
  }

  const byFileAndSymbol = new Map<string, FunctionAstEvidence>();
  const bySymbol = new Map<string, FunctionAstEvidence>();

  for (const [key, internal] of internalMap.entries()) {
    const pub: FunctionAstEvidence = {
      symbol: internal.symbol,
      file: internal.fileStem,
      executedTestBlocks: internal.executedBlocks.size,
      assertionsOnOutcome: Math.max(
        internal.directStrongAssertions,
        internal.strongAssertedBlocks.size,
      ),
      weakAssertionsOnly: Math.max(
        internal.directWeakAssertions,
        internal.weakAssertedBlocks.size,
      ),
      testFiles: Array.from(internal.testFiles),
    };
    byFileAndSymbol.set(key, pub);
    const existingBySym = bySymbol.get(internal.symbol);
    if (!existingBySym || pub.assertionsOnOutcome > existingBySym.assertionsOnOutcome) {
      bySymbol.set(internal.symbol, pub);
    }
  }

  let inlineTestCount = 0;
  for (const internal of internalMap.values()) {
    for (const tf of internal.testFiles) {
      if (!testFiles.includes(tf)) {
        inlineTestCount++;
      }
    }
  }

  return {
    testFileCount: testFiles.length + inlineTestCount,
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
