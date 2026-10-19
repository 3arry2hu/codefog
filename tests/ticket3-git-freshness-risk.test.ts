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

describe("Ticket 3: Git Freshness (Fog Returned, Self-proof Fog), AST comment/type filtering & Risk Score", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefog-t3-"));
    await git(tmpDir, ["init", "-b", "main"]);
    await git(tmpDir, ["config", "user.name", "Test Bot"]);
    await git(tmpDir, ["config", "user.email", "bot@example.com"]);

    await fs.mkdir(path.join(tmpDir, "src", "payments"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "tests"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "coverage"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("identifies self-proof-fog on same-commit code+test, ignores comment/type edits, and flags fog-returned on runtime logic changes", async () => {
    const paymentFile = path.join(tmpDir, "src", "payments", "charge.ts");
    const testFile = path.join(tmpDir, "tests", "charge.test.ts");
    const lcovFile = path.join(tmpDir, "coverage", "lcov.info");

    // Step 1: Agent creates implementation and test in the SAME commit
    await fs.writeFile(
      paymentFile,
      [
        "export function chargeCard(amount: number): number {",
        "  if (amount <= 0) {",
        "    return 0;",
        "  }",
        "  return amount;",
        "}",
        "",
        "export function refundCard(amount: number): number {",
        "  return -amount;",
        "}",
      ].join("\n"),
      "utf8",
    );

    await fs.writeFile(
      testFile,
      [
        "import { describe, it, expect } from 'vitest';",
        "import { chargeCard, refundCard } from '../src/payments/charge.js';",
        "",
        "describe('charge', () => {",
        "  it('charges positive and zero amounts', () => {",
        "    expect(chargeCard(100)).toBe(100);",
        "    expect(chargeCard(0)).toBe(0);",
        "  });",
        "  it('refunds amount', () => {",
        "    expect(refundCard(50)).toBe(-50);",
        "  });",
        "});",
      ].join("\n"),
      "utf8",
    );

    const lcovContent = [
      "TN:",
      "SF:src/payments/charge.ts",
      "FN:1,chargeCard",
      "FN:8,refundCard",
      "FNF:2",
      "FNH:2",
      "FNDA:2,chargeCard",
      "FNDA:1,refundCard",
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
    ].join("\n");
    await fs.writeFile(lcovFile, lcovContent, "utf8");

    await git(tmpDir, ["add", "."]);
    await git(tmpDir, ["commit", "-m", "feat: add charge and refund with self-authored tests"]);

    // Analyze after Commit 1: both functions were created in the exact same commit as their test -> self-proof-fog
    const report1 = await analyzeRepository({ rootDir: tmpDir });
    expect(report1.summary.locByState["self-proof-fog"]).toBe(6);
    expect(report1.summary.locByState["fog-returned"]).toBe(0);
    expect(report1.summary.locByState.verified).toBe(0);

    // Step 2: Modify only comments and TypeScript interfaces/types in src/payments/charge.ts
    await fs.writeFile(
      paymentFile,
      [
        "// Added header comment and interface only",
        "export interface ChargeOptions { currency?: string; }",
        "export type AmountCents = number;",
        "export function chargeCard(amount: AmountCents): number {",
        "  // Pure comment inside function body",
        "  if (amount <= 0) {",
        "    return 0;",
        "  }",
        "  return amount;",
        "}",
        "",
        "export function refundCard(amount: AmountCents): number {",
        "  return -amount;",
        "}",
      ].join("\n"),
      "utf8",
    );
    await git(tmpDir, ["add", "src/payments/charge.ts"]);
    await git(tmpDir, ["commit", "-m", "docs: add comments and type aliases"]);

    const report2 = await analyzeRepository({ rootDir: tmpDir });
    // Pure comment/type changes MUST NOT trigger fog-returned!
    expect(report2.summary.locByState["fog-returned"]).toBe(0);
    expect(report2.summary.locByState["self-proof-fog"]).toBe(6);

    // Step 3: Modify executable runtime logic in chargeCard without updating tests
    await fs.writeFile(
      paymentFile,
      [
        "export function chargeCard(amount: number): number {",
        "  if (amount <= 10) {",
        "    return 0;",
        "  }",
        "  return Math.round(amount * 1.05);",
        "}",
        "",
        "export function refundCard(amount: number): number {",
        "  return -amount;",
        "}",
      ].join("\n"),
      "utf8",
    );
    await git(tmpDir, ["add", "src/payments/charge.ts"]);
    await git(tmpDir, ["commit", "-m", "feat: add 5% processing fee and min threshold"]);

    const report3 = await analyzeRepository({ rootDir: tmpDir });
    // chargeCard (4 instrumented lines) is now fog-returned; refundCard (2 instrumented lines) remains self-proof-fog!
    expect(report3.summary.locByState["fog-returned"]).toBe(4);
    expect(report3.summary.locByState["self-proof-fog"]).toBe(2);

    // Findings must be sorted by riskScore descending, so fog-returned chargeCard comes first
    expect(report3.findings.length).toBe(2);
    expect(report3.findings[0]?.location.symbol).toBe("chargeCard");
    expect(report3.findings[0]?.state).toBe("fog-returned");
    expect(report3.findings[0]?.evidence.lastCodeChangeAt).toBeDefined();
    expect(report3.findings[0]?.evidence.lastTestChangeAt).toBeDefined();
    expect(report3.findings[1]?.location.symbol).toBe("refundCard");
    expect(report3.findings[1]?.state).toBe("self-proof-fog");
    expect(report3.findings[0]!.riskScore).toBeGreaterThan(report3.findings[1]!.riskScore);

    // Verify --fail-on returned returns exit code 2 when fog-returned > 0, and --fail-on none returns 0
    const logs: string[] = [];
    const codeReturned = await runCli(["--root", tmpDir, "--fail-on", "returned"], {
      stdout: (m) => logs.push(m),
      stderr: (m) => logs.push(m),
    });
    expect(codeReturned).toBe(2);

    const codeNone = await runCli(["--root", tmpDir, "--fail-on", "none"], {
      stdout: (m) => logs.push(m),
      stderr: (m) => logs.push(m),
    });
    expect(codeNone).toBe(0);
  });
});
