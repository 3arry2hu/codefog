import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { analyzeRepository } from "../src/analyzer.js";
import { runCli } from "../src/cli.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

describe("Ticket 4: Stryker mutation report ingestion & codefog verify --mutants anti-gaming gates", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefog-t4-"));
    await git(tmpDir, ["init", "-b", "main"]);
    await git(tmpDir, ["config", "user.name", "Test Bot"]);
    await git(tmpDir, ["config", "user.email", "bot@example.com"]);

    await fs.mkdir(path.join(tmpDir, "src", "billing"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "tests"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "coverage"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "reports"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("ingests --stryker report: promotes self-proof-fog to verified when all mutants killed, downgrades to weak-evidence with survivingMutants when survived", async () => {
    const srcFile = path.join(tmpDir, "src", "billing", "tax.ts");
    const testFile = path.join(tmpDir, "tests", "tax.test.ts");
    const lcovFile = path.join(tmpDir, "coverage", "lcov.info");
    const strykerFile = path.join(tmpDir, "reports", "mutation.json");

    await fs.writeFile(
      srcFile,
      [
        "export function calcTax(amount: number): number {",
        "  if (amount >= 100) {",
        "    return amount * 0.2;",
        "  }",
        "  return amount * 0.1;",
        "}",
        "",
        "export function calcDuty(amount: number): number {",
        "  return amount + 15;",
        "}",
      ].join("\n"),
      "utf8",
    );

    await fs.writeFile(
      testFile,
      [
        "import { describe, it, expect } from 'vitest';",
        "import { calcTax, calcDuty } from '../src/billing/tax.js';",
        "describe('tax', () => {",
        "  it('calculates tax and duty', () => {",
        "    expect(calcTax(200)).toBe(40);",
        "    expect(calcTax(50)).toBe(5);",
        "    expect(calcDuty(100)).toBe(115);",
        "  });",
        "});",
      ].join("\n"),
      "utf8",
    );

    await fs.writeFile(
      lcovFile,
      [
        "TN:",
        "SF:src/billing/tax.ts",
        "FN:1,calcTax",
        "FN:8,calcDuty",
        "FNF:2",
        "FNH:2",
        "FNDA:2,calcTax",
        "FNDA:1,calcDuty",
        "DA:1,2",
        "DA:2,2",
        "DA:3,1",
        "DA:5,1",
        "DA:8,1",
        "DA:9,1",
        "LF:6",
        "LH:6",
        "BRDA:2,0,0,1",
        "BRDA:2,0,1,1",
        "BRF:2",
        "BRH:2",
        "end_of_record",
      ].join("\n"),
      "utf8",
    );

    // Commit code + test together -> initially both are self-proof-fog
    await git(tmpDir, ["add", "."]);
    await git(tmpDir, ["commit", "-m", "feat: add tax and duty"]);

    // Write Stryker JSON report:
    // calcTax has 1 Survived mutant on line 2 (amount >= 100 -> amount > 100) and 1 Killed mutant on line 3
    // calcDuty has 2 Killed mutants on line 9 (100% killed -> promotes from self-proof-fog to verified!)
    const strykerJson = {
      schemaVersion: "1",
      thresholds: { high: 80, low: 60 },
      files: {
        "src/billing/tax.ts": {
          language: "typescript",
          source: await fs.readFile(srcFile, "utf8"),
          mutants: [
            {
              id: "mut_1",
              mutatorName: "EqualityOperator",
              replacement: "amount > 100",
              originalLines: "amount >= 100",
              location: { start: { line: 2, column: 6 }, end: { line: 2, column: 19 } },
              status: "Survived",
              coveredBy: ["test_1", "test_2"],
            },
            {
              id: "mut_2",
              mutatorName: "ArithmeticOperator",
              replacement: "amount / 0.2",
              location: { start: { line: 3, column: 11 }, end: { line: 3, column: 23 } },
              status: "Killed",
              coveredBy: ["test_1"],
            },
            {
              id: "mut_3",
              mutatorName: "ArithmeticOperator",
              replacement: "amount - 15",
              location: { start: { line: 9, column: 9 }, end: { line: 9, column: 20 } },
              status: "Killed",
              coveredBy: ["test_1"],
            },
            {
              id: "mut_4",
              mutatorName: "BlockStatement",
              replacement: "{}",
              location: { start: { line: 8, column: 49 }, end: { line: 10, column: 1 } },
              status: "Killed",
              coveredBy: ["test_1"],
            },
          ],
        },
      },
    };
    await fs.writeFile(strykerFile, JSON.stringify(strykerJson, null, 2), "utf8");

    const report = await analyzeRepository({
      rootDir: tmpDir,
      strykerPath: "reports/mutation.json",
    });

    // 3 killed out of 4 total mutants = 75%
    expect(report.summary.metrics.mutationScorePct).toBe(75);

    // calcDuty (2 lines) was self-proof-fog, now promoted to verified because all its mutants were killed!
    expect(report.summary.locByState.verified).toBe(2);
    expect(report.summary.locByState["self-proof-fog"]).toBe(0);

    // calcTax (4 lines) downgraded to weak-evidence with 1 surviving mutant
    expect(report.summary.locByState["weak-evidence"]).toBe(4);
    const taxFinding = report.findings.find((f) => f.location.symbol === "calcTax");
    expect(taxFinding).toBeDefined();
    expect(taxFinding?.state).toBe("weak-evidence");
    expect(taxFinding?.evidence.survivingMutants.length).toBe(1);
    expect(taxFinding?.evidence.survivingMutants[0]).toMatchObject({
      id: "mut_1",
      line: 2,
      original: "amount >= 100",
      mutated: "amount > 100",
      testsRun: 2,
      killed: false,
    });
  });

  it("enforces anti-gaming gates in `codefog verify --mutants` (detects surviving mutants, branch deletion, and missing assertions)", async () => {
    const srcFile = path.join(tmpDir, "src", "billing", "guard.ts");
    const testFile = path.join(tmpDir, "tests", "guard.test.ts");
    const runnerScript = path.join(tmpDir, "run-tests.mjs");

    const originalSource = [
      "export function canApprove(score: number): boolean {",
      "  if (score >= 80) {",
      "    return true;",
      "  }",
      "  return false;",
      "}",
    ].join("\n");
    await fs.writeFile(srcFile, originalSource, "utf8");

    // Weak test that only checks score=100 (misses boundary 80 so >= mutated to > survives!)
    await fs.writeFile(
      testFile,
      [
        "import { describe, it, expect } from 'vitest';",
        "import { canApprove } from '../src/billing/guard.js';",
        "describe('guard', () => {",
        "  it('approves high score', () => {",
        "    expect(canApprove(100)).toBe(true);",
        "  });",
        "});",
      ].join("\n"),
      "utf8",
    );

    // Fast node test runner script that evaluates src/billing/guard.ts against the test expectations
    await fs.writeFile(
      runnerScript,
      [
        "import * as fs from 'node:fs';",
        "const src = fs.readFileSync('src/billing/guard.ts', 'utf8');",
        "const test = fs.readFileSync('tests/guard.test.ts', 'utf8');",
        "// Transpile export function to executable JS",
        "const jsBody = src.replace('export function canApprove(score: number): boolean', 'function canApprove(score)');",
        "const fn = new Function(jsBody + '; return canApprove;')();",
        "if (test.includes('canApprove(100)') && fn(100) !== true) process.exit(1);",
        "if (test.includes('canApprove(80)') && fn(80) !== true) process.exit(1);",
        "if (test.includes('canApprove(79)') && fn(79) !== false) process.exit(1);",
        "process.exit(0);",
      ].join("\n"),
      "utf8",
    );

    await git(tmpDir, ["add", "."]);
    await git(tmpDir, ["commit", "-m", "feat: initial guard"]);

    // Case 1: Boundary mutant `score >= 80` -> `score > 80` survives because test only checks 100!
    const out1: string[] = [];
    const code1 = await runCli(
      [
        "verify",
        "src/billing/guard.ts",
        "--root",
        tmpDir,
        "--mutants",
        "--lines",
        "1-6",
        "--test-cmd",
        "node run-tests.mjs",
      ],
      { stdout: (s) => out1.push(s), stderr: (s) => out1.push(s) },
    );
    expect(code1).toBe(2);
    expect(out1.join("")).toMatch(/Surviving mutant|mutant.*survived/i);
    // Confirm source file was cleanly restored after mutation testing
    expect(await fs.readFile(srcFile, "utf8")).toBe(originalSource);

    // Case 2: Agent tries to game the score by deleting the `if (score >= 80)` branch from source code!
    await fs.writeFile(
      srcFile,
      [
        "export function canApprove(score: number): boolean {",
        "  return true;",
        "}",
      ].join("\n"),
      "utf8",
    );
    const out2: string[] = [];
    const code2 = await runCli(
      [
        "verify",
        "src/billing/guard.ts",
        "--root",
        tmpDir,
        "--mutants",
        "--test-cmd",
        "node run-tests.mjs",
      ],
      { stdout: (s) => out2.push(s), stderr: (s) => out2.push(s) },
    );
    expect(code2).toBe(2);
    expect(out2.join("")).toMatch(/anti-gaming|branch|modified|complexity/i);

    // Restore original source and strengthen tests with boundary checks (80 and 79)
    await fs.writeFile(srcFile, originalSource, "utf8");
    await fs.writeFile(
      testFile,
      [
        "import { describe, it, expect } from 'vitest';",
        "import { canApprove } from '../src/billing/guard.js';",
        "describe('guard', () => {",
        "  it('approves boundary 80 and rejects 79', () => {",
        "    expect(canApprove(100)).toBe(true);",
        "    expect(canApprove(80)).toBe(true);",
        "    expect(canApprove(79)).toBe(false);",
        "  });",
        "});",
      ].join("\n"),
      "utf8",
    );

    // Case 3: All mutants are now killed, source branches intact, strong assertions present -> exit code 0!
    const out3: string[] = [];
    const code3 = await runCli(
      [
        "verify",
        "src/billing/guard.ts",
        "--root",
        tmpDir,
        "--mutants",
        "--lines",
        "1-6",
        "--test-cmd",
        "node run-tests.mjs",
      ],
      { stdout: (s) => out3.push(s), stderr: (s) => out3.push(s) },
    );
    expect(code3).toBe(0);
    expect(out3.join("")).toMatch(/VERIFIED|passed/i);
    expect(await fs.readFile(srcFile, "utf8")).toBe(originalSource);
  });
});
