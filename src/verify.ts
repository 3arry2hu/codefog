import * as fs from "node:fs/promises";
import * as path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import ts from "typescript";
import { analyzeTestAstEvidence, lookupFunctionAstEvidence } from "./ast-evidence.js";
import type { SurvivingMutant } from "./types.js";

const execAsync = promisify(exec);

export interface VerifyOptions {
  rootDir: string;
  targetFile: string;
  mutants: boolean;
  startLine?: number;
  endLine?: number;
  testCmd?: string;
  allowSourceChange?: boolean;
}

export interface VerifyResult {
  passed: boolean;
  exitCode: number;
  summary: string;
  totalMutants: number;
  killedMutants: number;
  survivingMutants: SurvivingMutant[];
  violations: string[];
}

interface CandidateMutation {
  id: string;
  line: number;
  original: string;
  mutated: string;
  mutatedSource: string;
}

function countControlFlowBranches(sourceText: string, fileName: string): number {
  const sf = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  let count = 0;
  function walk(node: ts.Node): void {
    switch (node.kind) {
      case ts.SyntaxKind.IfStatement:
      case ts.SyntaxKind.ConditionalExpression:
      case ts.SyntaxKind.SwitchStatement:
      case ts.SyntaxKind.CaseClause:
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement:
      case ts.SyntaxKind.CatchClause:
        count++;
        break;
      case ts.SyntaxKind.BinaryExpression: {
        const bin = node as ts.BinaryExpression;
        if (
          bin.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          bin.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          bin.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        ) {
          count++;
        }
        break;
      }
    }
    ts.forEachChild(node, walk);
  }
  walk(sf);
  return count;
}

function extractFunctionNamesInRange(
  sourceText: string,
  fileName: string,
  startLine?: number,
  endLine?: number,
): string[] {
  const sf = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const names: string[] = [];

  function checkAndAdd(name: string, node: ts.Node): void {
    const fnStart = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const fnEnd = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    if (startLine !== undefined && endLine !== undefined) {
      if (fnEnd < startLine || fnStart > endLine) return;
    }
    names.push(name);
  }

  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name) {
      checkAndAdd(node.name.text, node);
      return;
    }
    if (ts.isMethodDeclaration(node) && node.name) {
      checkAndAdd(node.name.getText(sf), node);
      return;
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      checkAndAdd(node.name.text, node);
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return names;
}

export function generateCandidateMutations(
  sourceText: string,
  fileName: string,
  startLine?: number,
  endLine?: number,
): CandidateMutation[] {
  const sf = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const candidates: CandidateMutation[] = [];
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
        (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
        node.body &&
        node.body.statements.length > 0
      ) {
        // Method body clearance check (Pseudo-tested method detector)
        const bodyLine = sf.getLineAndCharacterOfPosition(node.body.getStart(sf)).line + 1;
        addReplacement(node.body, "{ return undefined as any; }", bodyLine);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return candidates;
}

async function runCommandPasses(cmd: string, cwd: string): Promise<boolean> {
  try {
    await execAsync(cmd, { cwd, timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

async function checkAntiGamingSourceIntegrity(
  rootDir: string,
  relTarget: string,
  currentSource: string,
): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`git show HEAD:${relTarget}`, { cwd: rootDir });
    if (!stdout) return null;
    const headBranches = countControlFlowBranches(stdout, relTarget);
    const currentBranches = countControlFlowBranches(currentSource, relTarget);
    if (currentBranches < headBranches) {
      return `Anti-gaming gate triggered: business source file ${relTarget} was modified and lost control-flow branches (${headBranches} -> ${currentBranches} branches compared to HEAD). Pass --allow-source-change if this refactoring is intentional.`;
    }
  } catch {
    // Not in git or file not in HEAD yet
  }
  return null;
}

async function detectDefaultTestCommand(
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

export async function verifyTargetWithMutants(options: VerifyOptions): Promise<VerifyResult> {
  const rootDir = path.resolve(options.rootDir);
  const absTarget = path.resolve(rootDir, options.targetFile);
  const relTarget = path.relative(rootDir, absTarget).replace(/\\/g, "/");

  const originalSource = await fs.readFile(absTarget, "utf8");
  const violations: string[] = [];

  // Gate 1: Anti-gaming check against deleting business source branches
  if (!options.allowSourceChange) {
    const branchViolation = await checkAntiGamingSourceIntegrity(
      rootDir,
      relTarget,
      originalSource,
    );
    if (branchViolation) {
      violations.push(branchViolation);
    }
  }

  // Gate 2: AST outcome assertion check on target functions
  const astResult = await analyzeTestAstEvidence(rootDir);
  const targetFns = extractFunctionNamesInRange(
    originalSource,
    relTarget,
    options.startLine,
    options.endLine,
  );
  const associatedTestFiles = new Set<string>();
  for (const fnName of targetFns) {
    const ev = lookupFunctionAstEvidence(astResult, relTarget, fnName);
    if (ev) {
      for (const tf of ev.testFiles) associatedTestFiles.add(tf);
    }
    if (!ev || ev.assertionsOnOutcome === 0) {
      violations.push(
        `Anti-gaming gate triggered: function '${fnName}' in ${relTarget} has 0 outcome assertions in tests (pseudo-tested or untested).`,
      );
    }
  }

  if (violations.length > 0) {
    return {
      passed: false,
      exitCode: 1,
      summary: `Verification FAILED for ${relTarget}:\n` + violations.map((v) => `  - ${v}`).join("\n"),
      totalMutants: 0,
      killedMutants: 0,
      survivingMutants: [],
      violations,
    };
  }

  const testCmd =
    options.testCmd ??
    (await detectDefaultTestCommand(rootDir, Array.from(associatedTestFiles)));

  // First ensure baseline tests pass on unmodified source
  const baselinePass = await runCommandPasses(testCmd, rootDir);
  if (!baselinePass) {
    const msg = `Baseline test command failed before mutation testing: ${testCmd}`;
    return {
      passed: false,
      exitCode: 1,
      summary: msg,
      totalMutants: 0,
      killedMutants: 0,
      survivingMutants: [],
      violations: [msg],
    };
  }

  // Gate 3: Targeted mutation verification (runs full operator + body clearance mutants when --mutants is set, or body clearance check by default)
  const allCandidates = generateCandidateMutations(
    originalSource,
    relTarget,
    options.startLine,
    options.endLine,
  );
  const candidates = options.mutants
    ? allCandidates
    : allCandidates.filter((c) => c.mutated.includes("return undefined"));

  const survivingMutants: SurvivingMutant[] = [];
  let killedMutants = 0;

  try {
    for (const candidate of candidates) {
      await fs.writeFile(absTarget, candidate.mutatedSource, "utf8");
      const mutantSurvived = await runCommandPasses(testCmd, rootDir);
      if (mutantSurvived) {
        survivingMutants.push({
          id: candidate.id,
          line: candidate.line,
          original: candidate.original,
          mutated: candidate.mutated,
          testsRun: 1,
          killed: false,
        });
      } else {
        killedMutants++;
      }
    }
  } finally {
    // Always restore original file content!
    await fs.writeFile(absTarget, originalSource, "utf8");
  }

  if (survivingMutants.length > 0) {
    for (const sm of survivingMutants) {
      violations.push(
        `Surviving mutant [${sm.id}] at ${relTarget}:${sm.line}: '${sm.original}' -> '${sm.mutated}' survived test suite.`,
      );
    }
    return {
      passed: false,
      exitCode: 1,
      summary:
        `Verification FAILED for ${relTarget}: ${survivingMutants.length} mutant(s) survived (${killedMutants}/${candidates.length} killed).\n` +
        violations.map((v) => `  - ${v}`).join("\n"),
      totalMutants: candidates.length,
      killedMutants,
      survivingMutants,
      violations,
    };
  }

  return {
    passed: true,
    exitCode: 0,
    summary: `VERIFIED ${relTarget}: All ${killedMutants}/${candidates.length} mutants killed and anti-gaming gates passed.`,
    totalMutants: candidates.length,
    killedMutants,
    survivingMutants: [],
    violations: [],
  };
}
