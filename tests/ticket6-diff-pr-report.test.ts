import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runCli } from "../src/cli.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

describe("Ticket 6: Incremental --diff and PR Before/After Comparison Report (--pr-comment)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefog-t6-"));
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

  it("detects 'Coverage up, evidence down' when line coverage rises while checked coverage / trust score drops, and writes pr-diff.svg & pr-comment.md", async () => {
    const srcFile = path.join(tmpDir, "src", "payments", "checkout.ts");
    const testFile = path.join(tmpDir, "tests", "checkout.test.ts");
    const lcovFile = path.join(tmpDir, "coverage", "lcov.info");

    // Commit 1 (base branch `main`):
    // validateCart (2 lines) has strong assertion -> verified
    // processPayment (3 lines) is not executed -> fog
    // Line coverage = 2/5 = 40%, Checked coverage = 2/5 = 40%
    await fs.writeFile(
      srcFile,
      [
        "export function validateCart(items: number): boolean {",
        "  return items > 0;",
        "}",
        "",
        "export function processPayment(amount: number): boolean {",
        "  const tax = amount * 0.1;",
        "  return amount + tax > 0;",
        "}",
      ].join("\n"),
      "utf8",
    );

    // First commit source, then commit test so validateCart is genuinely verified (not same-commit self-proof)
    await git(tmpDir, ["add", "src/payments/checkout.ts"]);
    await git(tmpDir, ["commit", "-m", "feat: add checkout source"]);

    await fs.writeFile(
      testFile,
      [
        "import { describe, it, expect } from 'vitest';",
        "import { validateCart, processPayment } from '../src/payments/checkout.js';",
        "describe('checkout', () => {",
        "  it('validates cart', () => {",
        "    expect(validateCart(2)).toBe(true);",
        "  });",
        "});",
      ].join("\n"),
      "utf8",
    );

    await fs.writeFile(
      lcovFile,
      [
        "TN:",
        "SF:src/payments/checkout.ts",
        "FN:1,validateCart",
        "FN:5,processPayment",
        "FNF:2",
        "FNH:1",
        "FNDA:1,validateCart",
        "FNDA:0,processPayment",
        "DA:1,1",
        "DA:2,1",
        "DA:5,0",
        "DA:6,0",
        "DA:7,0",
        "LF:5",
        "LH:2",
        "end_of_record",
      ].join("\n"),
      "utf8",
    );

    await git(tmpDir, ["add", "."]);
    await git(tmpDir, ["commit", "-m", "test: add strong test for validateCart"]);

    // Create feature branch where PR modifies validateCart logic AND replaces tests with assertion-free calls on both functions!
    // Line coverage jumps from 40% (2/5) to 100% (5/5), while Checked Coverage drops from 40% to 0%!
    await git(tmpDir, ["checkout", "-b", "feat/pr-change"]);

    await fs.writeFile(
      srcFile,
      [
        "export function validateCart(items: number): boolean {",
        "  return items >= 2;",
        "}",
        "",
        "export function processPayment(amount: number): boolean {",
        "  const tax = amount * 0.2;",
        "  return amount + tax > 10;",
        "}",
      ].join("\n"),
      "utf8",
    );

    await fs.writeFile(
      testFile,
      [
        "import { describe, it } from 'vitest';",
        "import { validateCart, processPayment } from '../src/payments/checkout.js';",
        "describe('checkout', () => {",
        "  it('calls both functions without any assertions', () => {",
        "    validateCart(2);",
        "    processPayment(100);",
        "  });",
        "});",
      ].join("\n"),
      "utf8",
    );

    await fs.writeFile(
      lcovFile,
      [
        "TN:",
        "SF:src/payments/checkout.ts",
        "FN:1,validateCart",
        "FN:5,processPayment",
        "FNF:2",
        "FNH:2",
        "FNDA:1,validateCart",
        "FNDA:1,processPayment",
        "DA:1,1",
        "DA:2,1",
        "DA:5,1",
        "DA:6,1",
        "DA:7,1",
        "LF:5",
        "LH:5",
        "end_of_record",
      ].join("\n"),
      "utf8",
    );

    const outDir = path.join(tmpDir, ".codefog");
    const stdoutChunks: string[] = [];
    const exitCode = await runCli(
      [
        "--root",
        tmpDir,
        "--diff",
        "main",
        "--pr-comment",
        outDir,
        "--json",
        "--fail-on",
        "regression",
      ],
      {
        stdout: (s) => stdoutChunks.push(s),
        stderr: () => {},
      },
    );

    // Because evidence regressed (Coverage up, evidence down), --fail-on regression returns exit code 1
    expect(exitCode).toBe(1);

    const report = JSON.parse(stdoutChunks.join(""));
    expect(report.diff).toBeDefined();
    expect(report.diff.baseRef).toBe("main");
    expect(report.diff.coverageUpEvidenceDown).toBe(true);
    expect(report.diff.alertHeadline).toContain("Coverage up, evidence down");
    expect(report.diff.beforeSummary.metrics.lineCoveragePct).toBe(40);
    expect(report.summary.metrics.lineCoveragePct).toBe(100);
    expect(report.diff.beforeSummary.metrics.checkedCoveragePct).toBe(40);
    expect(report.summary.metrics.checkedCoveragePct).toBe(0);

    const svgPath = path.join(outDir, "pr-diff.svg");
    const mdPath = path.join(outDir, "pr-comment.md");

    const svg = await fs.readFile(svgPath, "utf8");
    const md = await fs.readFile(mdPath, "utf8");

    expect(svg).toContain("<svg");
    expect(svg).toContain("BEFORE (main)");
    expect(svg).toContain("AFTER (PR)");
    expect(svg).toContain("#BD4900");
    expect(svg).toContain("#1D3656");

    expect(md).toContain("Coverage up, evidence down");
    expect(md).toContain("Trust Score");
    expect(md).toContain("Checked Coverage");
    expect(md).toContain("Pseudo-tested");
    expect(md).toContain("pr-diff.svg");
  });
});
