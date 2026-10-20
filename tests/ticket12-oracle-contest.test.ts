import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { analyzeRepository } from "../src/analyzer.js";
import { runCli } from "../src/cli.js";
import { verifyTargetWithMutants } from "../src/verify.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

describe("Ticket 12: independent expectations and historical defects", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefog-t12-"));
    await git(tmpDir, ["init", "-b", "main"]);
    await git(tmpDir, ["config", "user.name", "Test Bot"]);
    await git(tmpDir, ["config", "user.email", "bot@example.com"]);
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "tests"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "coverage"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "oracles"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("promotes self-proof fog only when a later commit confirms the asserted literal", async () => {
    await writeDuty(tmpDir, "toBe(115)");
    await git(tmpDir, ["add", "src", "tests", "coverage"]);
    await git(tmpDir, ["commit", "-m", "feat: add duty"]);

    const coupled = await analyzeRepository({ rootDir: tmpDir });
    expect(coupled.summary.locByState["self-proof-fog"]).toBeGreaterThan(0);
    expect(coupled.summary.locByState.verified).toBe(0);

    await fs.writeFile(
      path.join(tmpDir, "oracles", "expectations.json"),
      JSON.stringify({
        expectations: [
          {
            id: "EXP-1",
            file: "src/duty.ts",
            symbol: "calcDuty",
            expectedLiteral: "115",
          },
        ],
      }),
      "utf8",
    );
    await git(tmpDir, ["add", "oracles/expectations.json"]);
    await git(tmpDir, ["commit", "-m", "test: confirm duty expectation"]);

    const confirmed = await analyzeRepository({ rootDir: tmpDir });
    expect(confirmed.summary.locByState.verified).toBeGreaterThan(0);
    expect(confirmed.summary.locByState["self-proof-fog"]).toBe(0);
    expect(confirmed.summary.metrics.contestedOracles).toBe(0);
    expect(confirmed.findings.find((f) => f.location.symbol === "calcDuty")).toBeUndefined();
  });

  it("does not treat an expectation committed with the implementation as independent", async () => {
    await writeDuty(tmpDir, "toBe(115)");
    await fs.writeFile(
      path.join(tmpDir, "oracles", "expectations.json"),
      JSON.stringify({
        expectations: [
          {
            id: "EXP-1",
            file: "src/duty.ts",
            symbol: "calcDuty",
            expectedLiteral: "115",
          },
        ],
      }),
      "utf8",
    );
    await git(tmpDir, ["add", "."]);
    await git(tmpDir, ["commit", "-m", "feat: duty and expectation together"]);

    const report = await analyzeRepository({ rootDir: tmpDir });
    const finding = report.findings.find((f) => f.location.symbol === "calcDuty");
    expect(finding?.state).toBe("self-proof-fog");
    expect(finding?.agentReady).toBe(false);
    expect(finding?.evidence.oracleContest).toBe(false);
  });

  it("marks a contradicting expectation as an oracle contest and fails --fail-on contested", async () => {
    await writeDuty(tmpDir, "toBe(115)");
    await git(tmpDir, ["add", "src", "tests", "coverage"]);
    await git(tmpDir, ["commit", "-m", "feat: add duty"]);
    await fs.writeFile(
      path.join(tmpDir, "oracles", "expectations.json"),
      JSON.stringify({
        expectations: [
          {
            id: "EXP-1",
            file: "src/duty.ts",
            symbol: "calcDuty",
            expectedLiteral: "999",
          },
        ],
      }),
      "utf8",
    );
    await git(tmpDir, ["add", "oracles/expectations.json"]);
    await git(tmpDir, ["commit", "-m", "test: record the real duty"]);

    const report = await analyzeRepository({ rootDir: tmpDir });
    const finding = report.findings.find((f) => f.location.symbol === "calcDuty");
    expect(finding?.state).toBe("self-proof-fog");
    expect(finding?.agentReady).toBe(false);
    expect(finding?.evidence.oracleContest).toBe(true);
    expect(finding?.evidence.oracleIds).toEqual(["EXP-1"]);
    expect(finding?.suggestedAction).toContain("Do not rewrite");
    expect(report.summary.metrics.contestedOracles).toBe(1);

    let err = "";
    const code = await runCli(["--root", tmpDir, "--fail-on", "contested"], {
      stdout: () => {},
      stderr: (chunk) => {
        err += chunk;
      },
    });
    expect(code).toBe(1);
    expect(err).toBe("");
  });

  it("treats an assertion of the rejected historical outcome as an oracle contest", async () => {
    await writeDuty(tmpDir, "toBe(20)");
    await git(tmpDir, ["add", "src", "tests", "coverage"]);
    await git(tmpDir, ["commit", "-m", "feat: add duty"]);
    await fs.writeFile(
      path.join(tmpDir, "oracles", "defects.json"),
      JSON.stringify({
        defects: [
          {
            id: "BUG-1",
            file: "src/duty.ts",
            symbol: "calcDuty",
            inputLiteral: "100",
            expectedLiteral: "115",
            rejectedLiteral: "20",
          },
        ],
      }),
      "utf8",
    );
    await git(tmpDir, ["add", "oracles/defects.json"]);
    await git(tmpDir, ["commit", "-m", "test: record duty defect"]);

    const report = await analyzeRepository({ rootDir: tmpDir });
    const finding = report.findings.find((f) => f.location.symbol === "calcDuty");
    expect(finding?.evidence.oracleContest).toBe(true);
    expect(finding?.evidence.oracleIds).toContain("BUG-1");
    expect(finding?.agentReady).toBe(false);
    expect(report.summary.metrics.contestedOracles).toBe(1);
  });

  it("reports a missing historical input as a missed boundary instead of an oracle contest", async () => {
    await fs.writeFile(
      path.join(tmpDir, "src", "duty.ts"),
      "export function calcDuty(amount: number): number {\n  return amount + 15;\n}\n",
      "utf8",
    );
    await git(tmpDir, ["add", "src/duty.ts"]);
    await git(tmpDir, ["commit", "-m", "feat: add duty"]);

    await fs.writeFile(
      path.join(tmpDir, "tests", "duty.test.ts"),
      [
        "import { expect, it } from 'vitest';",
        "import { calcDuty } from '../src/duty.js';",
        "it('charges a small amount', () => {",
        "  expect(calcDuty(50)).toBe(65);",
        "});",
      ].join("\n"),
      "utf8",
    );
    await writeLcov(tmpDir);
    await git(tmpDir, ["add", "tests", "coverage"]);
    await git(tmpDir, ["commit", "-m", "test: cover small amount"]);

    await fs.writeFile(
      path.join(tmpDir, "oracles", "defects.json"),
      JSON.stringify({
        defects: [
          {
            id: "BUG-9",
            file: "src/duty.ts",
            symbol: "calcDuty",
            inputLiteral: "100",
            expectedLiteral: "115",
          },
        ],
      }),
      "utf8",
    );
    await git(tmpDir, ["add", "oracles/defects.json"]);
    await git(tmpDir, ["commit", "-m", "test: record missing boundary"]);

    const report = await analyzeRepository({ rootDir: tmpDir });
    const finding = report.findings.find((f) => f.location.symbol === "calcDuty");
    expect(finding?.state).toBe("weak-evidence");
    expect(finding?.agentReady).toBe(true);
    expect(finding?.evidence.oracleContest).toBe(false);
    expect(finding?.evidence.missedBoundary).toBe(true);
    expect(finding?.evidence.oracleIds).toEqual(["BUG-9"]);
    expect(finding?.suggestedAction).toContain("115");
    expect(report.summary.metrics.contestedOracles).toBe(0);
  });

  it("fails verify --oracle when the assertion contradicts the expectation", async () => {
    await writeDuty(tmpDir, "toBe(115)");
    await fs.writeFile(
      path.join(tmpDir, "oracles", "expectations.json"),
      JSON.stringify({
        expectations: [
          {
            id: "EXP-1",
            file: "src/duty.ts",
            symbol: "calcDuty",
            expectedLiteral: "999",
          },
        ],
      }),
      "utf8",
    );

    const result = await verifyTargetWithMutants({
      rootDir: tmpDir,
      targetFile: "src/duty.ts",
      mutants: false,
      oracle: true,
    });
    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.summary).toContain("Oracle contest");
    expect(result.summary).toContain("EXP-1");
    expect(result.summary).toContain("Do not rewrite");
  });
});

async function writeDuty(root: string, matcher: string): Promise<void> {
  await fs.writeFile(
    path.join(root, "src", "duty.ts"),
    "export function calcDuty(amount: number): number {\n  return amount + 15;\n}\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(root, "tests", "duty.test.ts"),
    [
      "import { expect, it } from 'vitest';",
      "import { calcDuty } from '../src/duty.js';",
      "it('calculates duty', () => {",
      `  expect(calcDuty(100)).${matcher};`,
      "});",
    ].join("\n"),
    "utf8",
  );
  await writeLcov(root);
}

async function writeLcov(root: string): Promise<void> {
  await fs.writeFile(
    path.join(root, "coverage", "lcov.info"),
    [
      "TN:",
      "SF:src/duty.ts",
      "FN:1,calcDuty",
      "FNDA:1,calcDuty",
      "DA:1,1",
      "DA:2,1",
      "LF:2",
      "LH:2",
      "end_of_record",
    ].join("\n"),
    "utf8",
  );
}
