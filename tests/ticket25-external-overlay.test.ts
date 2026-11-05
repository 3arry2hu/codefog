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

describe("Ticket #25: External SARIF / Knip / libyear overlay and Risk Score multiplier", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefog-t25-"));
    await git(tmpDir, ["init", "-b", "main"]);
    await git(tmpDir, ["config", "user.name", "Test Bot"]);
    await git(tmpDir, ["config", "user.email", "bot@example.com"]);

    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "tests"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "coverage"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("imports SARIF 2.1.0 issues into region/finding overlay, multiplies raw Risk Score by 1 + ln(1 + n_external), and keeps Trust Score, lineStates, and 5-state counts unchanged", async () => {
    const feeFile = path.join(tmpDir, "src", "fee.ts");
    const testFile = path.join(tmpDir, "tests", "fee.test.ts");
    const lcovFile = path.join(tmpDir, "coverage", "lcov.info");
    const sarifFile = path.join(tmpDir, "qlty.sarif.json");

    await fs.writeFile(
      feeFile,
      [
        "export function calculateFee(amount: number): number {",
        "  if (amount <= 0) {",
        "    return 0;",
        "  }",
        "  return Math.round(amount * 0.03);",
        "}",
        "",
        "export function formatFeeLabel(amount: number): string {",
        "  return `$${amount}`;",
        "}",
      ].join("\n"),
      "utf8",
    );

    // Liveness-only test for formatFeeLabel so it is weak-evidence (giving a non-zero Trust Score = 13)
    await fs.writeFile(
      testFile,
      [
        "import { describe, it, expect } from 'vitest';",
        "import { formatFeeLabel } from '../src/fee.js';",
        "describe('fee', () => {",
        "  it('formats label', () => {",
        "    expect(formatFeeLabel(10)).toBeDefined();",
        "  });",
        "});",
      ].join("\n"),
      "utf8",
    );

    await fs.writeFile(
      lcovFile,
      [
        "TN:",
        "SF:src/fee.ts",
        "FN:1,calculateFee",
        "FN:8,formatFeeLabel",
        "FNF:2",
        "FNH:1",
        "FNDA:0,calculateFee",
        "FNDA:1,formatFeeLabel",
        "DA:1,0",
        "DA:2,0",
        "DA:3,0",
        "DA:5,0",
        "DA:8,1",
        "DA:9,1",
        "LF:6",
        "LH:2",
        "end_of_record",
      ].join("\n"),
      "utf8",
    );

    await git(tmpDir, ["add", "."]);
    await git(tmpDir, ["commit", "-m", "feat: add calculateFee and formatFeeLabel"]);

    // Baseline without external report:
    // calculateFee: unverifiedLoc=4 (ln 5 = 1.6094), churn90d=1 (ln 2 = 0.6931), complexity=2 (ln 3 = 1.0986), state=fog (weight 1.4)
    // raw_0 = 1.7158086 -> normalized = (1.7158086 / 5.2158086) * 10 = 3.2896 -> 3.3
    const baseline = await analyzeRepository({ rootDir: tmpDir });
    const baseCalcRegion = baseline.files[0]?.regions.find((r) => r.symbol === "calculateFee");
    expect(baseCalcRegion?.riskScore).toBe(3.3);
    expect(baseline.summary.trustScore).toBe(13);
    expect(baseline.summary.locByState).toEqual({
      "fog-returned": 0,
      fog: 4,
      "self-proof-fog": 0,
      "weak-evidence": 2,
      verified: 0,
    });

    // Write SARIF 2.1.0 report with 2 findings inside calculateFee (lines 2 and 5)
    await fs.writeFile(
      sarifFile,
      JSON.stringify(
        {
          $schema: "https://json.schemastore.org/sarif-2.1.0.json",
          version: "2.1.0",
          runs: [
            {
              tool: {
                driver: {
                  name: "qlty",
                },
              },
              results: [
                {
                  ruleId: "qlty/high-complexity",
                  level: "warning",
                  message: { text: "Function calculateFee has high cognitive complexity" },
                  locations: [
                    {
                      physicalLocation: {
                        artifactLocation: { uri: "src/fee.ts" },
                        region: { startLine: 2, endLine: 4 },
                      },
                    },
                  ],
                },
                {
                  ruleId: "semgrep/magic-fee-rate",
                  level: "note",
                  message: { text: "Avoid magic fee multiplier 0.03" },
                  locations: [
                    {
                      physicalLocation: {
                        artifactLocation: { uri: "src/fee.ts" },
                        region: { startLine: 5, endLine: 5 },
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    // With n_external = 2 in calculateFee:
    // raw_2 = raw_0 * (1 + ln(3)) = 1.7158086 * 2.0986123 = 3.6008172
    // normalized_2 = (3.6008172 / 7.1008172) * 10 = 5.07099 -> 5.1
    const withSarif = await analyzeRepository({
      rootDir: tmpDir,
      sarifPath: [sarifFile],
    });

    const sarifCalcRegion = withSarif.files[0]?.regions.find((r) => r.symbol === "calculateFee");
    expect(sarifCalcRegion?.riskScore).toBe(5.1);
    expect(sarifCalcRegion?.externalIssues).toHaveLength(2);
    expect(sarifCalcRegion?.externalIssues?.[0]).toMatchObject({
      source: "qlty",
      ruleId: "qlty/high-complexity",
      message: "Function calculateFee has high cognitive complexity",
      file: "src/fee.ts",
      startLine: 2,
      endLine: 4,
    });

    const sarifCalcFinding = withSarif.findings.find((f) => f.location.symbol === "calculateFee");
    expect(sarifCalcFinding?.riskScore).toBe(5.1);
    expect(sarifCalcFinding?.externalIssues).toHaveLength(2);

    // Trust Score, lineStates, and 5-state counts must be 100% identical before and after SARIF import
    expect(withSarif.summary.trustScore).toBe(baseline.summary.trustScore);
    expect(withSarif.summary.locByState).toEqual(baseline.summary.locByState);
    expect(withSarif.files[0]?.lineStates).toEqual(baseline.files[0]?.lineStates);
  });

  it("imports Knip JSON unused exports into corresponding region overlay with source 'knip' and updates Risk Score", async () => {
    const feeFile = path.join(tmpDir, "src", "fee.ts");
    const testFile = path.join(tmpDir, "tests", "fee.test.ts");
    const lcovFile = path.join(tmpDir, "coverage", "lcov.info");
    const knipFile = path.join(tmpDir, "knip-report.json");

    await fs.writeFile(
      feeFile,
      [
        "export function calculateFee(amount: number): number {",
        "  if (amount <= 0) {",
        "    return 0;",
        "  }",
        "  return Math.round(amount * 0.03);",
        "}",
        "",
        "export function formatFeeLabel(amount: number): string {",
        "  return `$${amount}`;",
        "}",
      ].join("\n"),
      "utf8",
    );

    await fs.writeFile(
      testFile,
      [
        "import { describe, it, expect } from 'vitest';",
        "import { formatFeeLabel } from '../src/fee.js';",
        "describe('fee', () => {",
        "  it('formats label', () => {",
        "    expect(formatFeeLabel(10)).toBeDefined();",
        "  });",
        "});",
      ].join("\n"),
      "utf8",
    );

    await fs.writeFile(
      lcovFile,
      [
        "TN:",
        "SF:src/fee.ts",
        "FN:1,calculateFee",
        "FN:8,formatFeeLabel",
        "FNF:2",
        "FNH:1",
        "FNDA:0,calculateFee",
        "FNDA:1,formatFeeLabel",
        "DA:1,0",
        "DA:2,0",
        "DA:3,0",
        "DA:5,0",
        "DA:8,1",
        "DA:9,1",
        "LF:6",
        "LH:2",
        "end_of_record",
      ].join("\n"),
      "utf8",
    );

    await git(tmpDir, ["add", "."]);
    await git(tmpDir, ["commit", "-m", "feat: add calculateFee and formatFeeLabel"]);

    await fs.writeFile(
      knipFile,
      JSON.stringify(
        {
          files: [],
          issues: [
            {
              file: "src/fee.ts",
              exports: [
                {
                  name: "formatFeeLabel",
                  line: 8,
                  col: 17,
                },
              ],
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const baseline = await analyzeRepository({ rootDir: tmpDir });
    const baseFormatRegion = baseline.files[0]?.regions.find(
      (r) => r.symbol === "formatFeeLabel",
    );
    expect(baseFormatRegion?.riskScore).toBe(1.3);

    const withKnip = await analyzeRepository({
      rootDir: tmpDir,
      knipPath: knipFile,
    });

    const knipFormatRegion = withKnip.files[0]?.regions.find(
      (r) => r.symbol === "formatFeeLabel",
    );
    expect(knipFormatRegion?.riskScore).toBe(2.0);
    expect(knipFormatRegion?.externalIssues).toHaveLength(1);
    expect(knipFormatRegion?.externalIssues?.[0]).toMatchObject({
      source: "knip",
      tool: "knip",
      ruleId: "unused-export",
      symbol: "formatFeeLabel",
      file: "src/fee.ts",
      line: 8,
    });
    expect(knipFormatRegion?.externalIssues?.[0]?.message).toContain("formatFeeLabel");
  });

  it("supports repeatable --sarif, --knip, and --libyear CLI flags, surfaces libyear in --json report, and renders external overlay in Level 4 HTML", async () => {
    const feeFile = path.join(tmpDir, "src", "fee.ts");
    const lcovFile = path.join(tmpDir, "coverage", "lcov.info");
    const sarif1 = path.join(tmpDir, "qlty.sarif");
    const sarif2 = path.join(tmpDir, "semgrep.sarif");
    const knipFile = path.join(tmpDir, "knip.json");
    const libyearFile = path.join(tmpDir, "libyear.json");

    await fs.writeFile(
      feeFile,
      [
        "export function calculateFee(amount: number): number {",
        "  if (amount <= 0) {",
        "    return 0;",
        "  }",
        "  return Math.round(amount * 0.03);",
        "}",
      ].join("\n"),
      "utf8",
    );

    await fs.writeFile(
      lcovFile,
      [
        "TN:",
        "SF:src/fee.ts",
        "FN:1,calculateFee",
        "FNF:1",
        "FNH:0",
        "FNDA:0,calculateFee",
        "DA:1,0",
        "DA:2,0",
        "DA:3,0",
        "DA:5,0",
        "LF:4",
        "LH:0",
        "end_of_record",
      ].join("\n"),
      "utf8",
    );

    await git(tmpDir, ["add", "."]);
    await git(tmpDir, ["commit", "-m", "feat: add calculateFee"]);

    await fs.writeFile(
      sarif1,
      JSON.stringify({
        version: "2.1.0",
        runs: [
          {
            tool: { driver: { name: "qlty" } },
            results: [
              {
                ruleId: "qlty/smell-boolean-complexity",
                message: { text: "Simplify negative amount guard" },
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: "src/fee.ts" },
                      region: { startLine: 2, endLine: 3 },
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
      "utf8",
    );

    await fs.writeFile(
      sarif2,
      JSON.stringify({
        version: "2.1.0",
        runs: [
          {
            tool: { driver: { name: "semgrep" } },
            results: [
              {
                ruleId: "semgrep/float-rounding",
                message: { text: "Floating-point fee rounding detected" },
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: "src/fee.ts" },
                      region: { startLine: 5, endLine: 5 },
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
      "utf8",
    );

    await fs.writeFile(
      knipFile,
      JSON.stringify({
        issues: [
          {
            file: "src/fee.ts",
            exports: [{ name: "calculateFee", line: 1 }],
          },
        ],
      }),
      "utf8",
    );

    await fs.writeFile(
      libyearFile,
      JSON.stringify([
        {
          dependency: "lodash",
          drift: 2.5,
          pulse: 0.4,
          releases: 6,
          major: 1,
          minor: 2,
          patch: 3,
          available: "4.17.21",
        },
        {
          dependency: "typescript",
          drift: 1.25,
          releases: 3,
          major: 0,
          minor: 3,
          patch: 0,
          available: "5.6.0",
        },
      ]),
      "utf8",
    );

    const out: string[] = [];
    const htmlOut = path.join(tmpDir, ".codefog", "report.html");
    const exitCode = await runCli(
      [
        "--root",
        tmpDir,
        "--sarif",
        sarif1,
        "--sarif",
        sarif2,
        "--knip",
        knipFile,
        "--libyear",
        libyearFile,
        "--html",
        htmlOut,
        "--json",
        "--fail-on",
        "none",
      ],
      {
        stdout: (s) => out.push(s),
        stderr: (s) => out.push(s),
      },
    );
    expect(exitCode).toBe(0);

    const report = JSON.parse(out.join(""));
    // 3 external issues in calculateFee (qlty + semgrep + knip):
    // raw_0 = 1.7158086, multiplier = 1 + ln(4) = 2.38629436
    // raw_3 = 4.0944235 -> normalized = (4.0944235 / 7.5944235) * 10 = 5.39135 -> 5.4
    const calcRegion = report.files[0]?.regions.find(
      (r: { symbol: string }) => r.symbol === "calculateFee",
    );
    expect(calcRegion.riskScore).toBe(5.4);
    expect(calcRegion.externalIssues).toHaveLength(3);
    expect(
      calcRegion.externalIssues.map((i: { source: string }) => i.source),
    ).toEqual(["qlty", "semgrep", "knip"]);

    // Repository-level libyear overlay in --json report
    expect(report.libyear).toBeDefined();
    expect(report.libyear.totalLibyears).toBe(3.75);
    expect(report.libyear.dependencies).toHaveLength(2);
    expect(report.libyear.dependencies[0]).toMatchObject({
      name: "lodash",
      libyears: 2.5,
    });
    expect(report.external?.libyear).toEqual(report.libyear);

    // Level 4 HTML contains source tool, ruleId, and message
    const html = await fs.readFile(htmlOut, "utf8");
    expect(html).toContain("qlty/smell-boolean-complexity");
    expect(html).toContain("Simplify negative amount guard");
    expect(html).toContain("semgrep/float-rounding");
    expect(html).toContain("Floating-point fee rounding detected");
    expect(html).toContain("unused-export");
  });

  it("omits external overlay fields when no external report is imported and caps Risk Score at 10.0", async () => {
    const feeFile = path.join(tmpDir, "src", "fee.ts");
    const lcovFile = path.join(tmpDir, "coverage", "lcov.info");

    await fs.writeFile(
      feeFile,
      [
        "export function calculateFee(amount: number): number {",
        "  if (amount <= 0) return 0;",
        "  if (amount < 10) return 1;",
        "  if (amount < 100) return 2;",
        "  if (amount < 1000) return 3;",
        "  if (amount < 10000) return 4;",
        "  return Math.round(amount * 0.03);",
        "}",
      ].join("\n"),
      "utf8",
    );

    await fs.writeFile(
      lcovFile,
      [
        "TN:",
        "SF:src/fee.ts",
        "FN:1,calculateFee",
        "FNF:1",
        "FNH:0",
        "FNDA:0,calculateFee",
        "DA:1,0",
        "DA:2,0",
        "DA:3,0",
        "DA:4,0",
        "DA:5,0",
        "DA:6,0",
        "DA:7,0",
        "LF:7",
        "LH:0",
        "end_of_record",
      ].join("\n"),
      "utf8",
    );

    await git(tmpDir, ["add", "."]);
    await git(tmpDir, ["commit", "-m", "feat: add complex calculateFee"]);

    const outNoExt: string[] = [];
    await runCli(["--root", tmpDir, "--json", "--fail-on", "none"], {
      stdout: (s) => outNoExt.push(s),
      stderr: (s) => outNoExt.push(s),
    });
    const rawJsonNoExt = outNoExt.join("");
    const parsedNoExt = JSON.parse(rawJsonNoExt);
    expect(parsedNoExt.external).toBeUndefined();
    expect(parsedNoExt.libyear).toBeUndefined();
    expect(parsedNoExt.files[0]?.externalIssues).toBeUndefined();
    expect(parsedNoExt.files[0]?.regions[0]?.externalIssues).toBeUndefined();
    expect(parsedNoExt.findings[0]?.externalIssues).toBeUndefined();

    // Even with a large number of external issues, Risk Score is capped at <= 10.0
    const sarifMany = path.join(tmpDir, "many.sarif.json");
    await fs.writeFile(
      sarifMany,
      JSON.stringify({
        version: "2.1.0",
        runs: [
          {
            tool: { driver: { name: "sonarqube" } },
            results: Array.from({ length: 50 }, (_, idx) => ({
              ruleId: `sonar/rule-${idx + 1}`,
              message: { text: `Code smell #${idx + 1}` },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: "src/fee.ts" },
                    region: { startLine: 2, endLine: 2 },
                  },
                },
              ],
            })),
          },
        ],
      }),
      "utf8",
    );

    const withMany = await analyzeRepository({
      rootDir: tmpDir,
      sarifPath: sarifMany,
    });
    expect(withMany.files[0]?.regions[0]?.riskScore).toBeLessThanOrEqual(10.0);
    expect(withMany.files[0]?.riskScore).toBeLessThanOrEqual(10.0);
  });
});
