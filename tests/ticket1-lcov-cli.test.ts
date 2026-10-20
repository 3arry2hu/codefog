import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { analyzeRepository } from "../src/analyzer.js";
import { runCli } from "../src/cli.js";

describe("Ticket 1: LCOV end-to-end CLI scan & --json report skeleton", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefog-t1-"));
    await fs.mkdir(path.join(tmpDir, "src", "billing"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "src", "auth"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "coverage"), { recursive: true });

    // src/auth/session.ts: fully executed & branches covered
    await fs.writeFile(
      path.join(tmpDir, "src", "auth", "session.ts"),
      [
        "export function verifyToken(token: string): boolean {",
        "  if (!token) {",
        "    return false;",
        "  }",
        "  return token.startsWith('valid_');",
        "}",
      ].join("\n"),
      "utf8",
    );

    // src/billing/refund.ts: two functions, one covered, one completely uncovered (fog)
    await fs.writeFile(
      path.join(tmpDir, "src", "billing", "refund.ts"),
      [
        "export function calculateFee(amount: number): number {",
        "  return Math.round(amount * 0.03);",
        "}",
        "",
        "export function processRefund(amount: number, total: number): string {",
        "  if (amount > total) {",
        "    return 'markPartial';",
        "  }",
        "  return 'fullRefund';",
        "}",
      ].join("\n"),
      "utf8",
    );

    const lcovContent = [
      "TN:",
      "SF:src/auth/session.ts",
      "FN:1,verifyToken",
      "FNF:1",
      "FNH:1",
      "FNDA:4,verifyToken",
      "DA:1,4",
      "DA:2,4",
      "DA:3,1",
      "DA:5,3",
      "LF:4",
      "LH:4",
      "BRDA:2,0,0,1",
      "BRDA:2,0,1,3",
      "BRF:2",
      "BRH:2",
      "end_of_record",
      "TN:",
      "SF:src/billing/refund.ts",
      "FN:1,calculateFee",
      "FN:5,processRefund",
      "FNF:2",
      "FNH:1",
      "FNDA:2,calculateFee",
      "FNDA:0,processRefund",
      "DA:1,2",
      "DA:2,2",
      "DA:5,0",
      "DA:6,0",
      "DA:7,0",
      "DA:9,0",
      "LF:6",
      "LH:2",
      "BRDA:6,0,0,0",
      "BRDA:6,0,1,0",
      "BRF:2",
      "BRH:0",
      "end_of_record",
    ].join("\n");

    await fs.writeFile(path.join(tmpDir, "coverage", "lcov.info"), lcovContent, "utf8");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("parses default coverage/lcov.info, aggregates LOC by state and module, and computes Trust Score", async () => {
    const report = await analyzeRepository({ rootDir: tmpDir });

    expect(report.$schema).toBe("https://codefog.dev/schemas/v1/report.json");
    expect(report.version).toBe("1.0.0");
    expect(report.summary.totalFiles).toBe(2);
    expect(report.summary.metrics.lineCoveragePct).toBe(60);
    expect(report.summary.metrics.branchCoveragePct).toBe(50);

    // 6 verified lines (4 in session.ts + 2 in refund.ts) and 4 fog lines (in refund.ts)
    expect(report.summary.locByState.verified).toBe(6);
    expect(report.summary.locByState.fog).toBe(4);
    expect(report.summary.locByState["fog-returned"]).toBe(0);
    expect(report.summary.trustScore).toBe(60);

    const billingMod = report.modules.find((m) => m.path === "src/billing");
    expect(billingMod).toBeDefined();
    expect(billingMod?.locByState.fog).toBe(4);
    expect(billingMod?.locByState.verified).toBe(2);
    expect(billingMod?.trustScore).toBe(33);

    const authMod = report.modules.find((m) => m.path === "src/auth");
    expect(authMod).toBeDefined();
    expect(authMod?.locByState.fog).toBe(0);
    expect(authMod?.locByState.verified).toBe(4);
    expect(authMod?.trustScore).toBe(100);
  });

  it("emits deterministic CF-xxxx Finding for fog regions via --json and Level 1 summary by default", async () => {
    let stdout = "";
    let stderr = "";
    const codeJson = await runCli([tmpDir, "--json", "--fail-on", "none"], {
      stdout: (s) => {
        stdout += s;
      },
      stderr: (s) => {
        stderr += s;
      },
    });

    expect(codeJson).toBe(0);
    expect(stderr).toBe("");
    const parsed = JSON.parse(stdout);
    expect(parsed.findings.length).toBeGreaterThanOrEqual(1);
    const refundFinding = parsed.findings.find(
      (f: { location: { file: string; symbol: string } }) =>
        f.location.file === "src/billing/refund.ts" && f.location.symbol === "processRefund",
    );
    expect(refundFinding).toBeDefined();
    expect(refundFinding.id).toMatch(/^CF-[0-9A-F]{4}$/i);
    expect(refundFinding.state).toBe("fog");
    expect(refundFinding.location.startLine).toBe(5);

    // Run again to verify ID is deterministic
    let stdout2 = "";
    await runCli([tmpDir, "--json", "--fail-on", "none"], {
      stdout: (s) => {
        stdout2 += s;
      },
      stderr: () => {},
    });
    const parsed2 = JSON.parse(stdout2);
    const refundFinding2 = parsed2.findings.find(
      (f: { location: { file: string; symbol: string } }) =>
        f.location.file === "src/billing/refund.ts" && f.location.symbol === "processRefund",
    );
    expect(refundFinding2.id).toBe(refundFinding.id);

    // Default CLI output prints Level 1 human summary
    let humanOut = "";
    const codeHuman = await runCli([tmpDir, "--fail-on", "none"], {
      stdout: (s) => {
        humanOut += s;
      },
      stderr: () => {},
    });
    expect(codeHuman).toBe(0);
    expect(humanOut).toContain("Trust Score: 60/100");
    expect(humanOut).toContain("src/billing");
  });

  it("handles CLI flags (--version, --help, --fail-on gates, invalid --fail-on, and missing verify target) through runCli seam", async () => {
    let verOut = "";
    expect(
      await runCli(["--version"], {
        stdout: (s) => {
          verOut += s;
        },
        stderr: () => {},
      }),
    ).toBe(0);
    expect(verOut.trim()).toBe("1.0.0");

    let helpOut = "";
    expect(
      await runCli(["--help"], {
        stdout: (s) => {
          helpOut += s;
        },
        stderr: () => {},
      }),
    ).toBe(0);
    expect(helpOut).toContain("Usage:");
    expect(helpOut).toContain("codefog verify <targetFile>");

    // --fail-on returned passes (0) when there is Fog (4 lines) but 0 Fog Returned
    expect(
      await runCli(["--root", tmpDir, "--fail-on", "returned"], {
        stdout: () => {},
        stderr: () => {},
      }),
    ).toBe(0);

    // --fail-on any-fog fails (1) because 4 lines are in Fog
    expect(
      await runCli(["--root", tmpDir, "--fail-on", "any-fog"], {
        stdout: () => {},
        stderr: () => {},
      }),
    ).toBe(1);

    // Unknown --fail-on policy must fail (1) rather than silently passing
    let invalidGateErr = "";
    expect(
      await runCli(["--root", tmpDir, "--fail-on", "unknown-policy"], {
        stdout: () => {},
        stderr: (s) => {
          invalidGateErr += s;
        },
      }),
    ).toBe(1);
    expect(invalidGateErr).toContain("Invalid --fail-on policy");

    // `codefog verify` without <target> fails (1) with actionable error
    let verifyErr = "";
    expect(
      await runCli(["verify", "--mutants"], {
        stdout: () => {},
        stderr: (s) => {
          verifyErr += s;
        },
      }),
    ).toBe(1);
    expect(verifyErr).toContain("requires a <target> file path");
  });
});
