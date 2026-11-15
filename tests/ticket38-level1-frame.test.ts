import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { runCli } from "../src/cli.js";
import { renderHtmlFogMap } from "../src/html-report.js";
import { renderPrCommentMarkdown } from "../src/diff-pr.js";
import type { CodefogReport, EvidenceState, Finding, LocByState } from "../src/types.js";

function loc(partial: Partial<LocByState>): LocByState {
  return { "fog-returned": 0, fog: 0, "self-proof-fog": 0, "weak-evidence": 0, verified: 0, ...partial };
}

function finding(i: number, state: EvidenceState = "fog"): Finding {
  return {
    id: `CF-${String(i).padStart(4, "0")}`,
    title: `fn${i}`,
    state,
    riskScore: 9 - i * 0.1,
    agentReady: true,
    location: { file: `src/f${i}.ts`, symbol: `fn${i}`, startLine: 1, endLine: 5 },
    reason: "no tests",
    evidence: {
      executedByTests: 0,
      assertionsOnOutcome: 0,
      pseudoTested: false,
      oracleContest: false,
      oracleIds: [],
      missedBoundary: false,
      survivingMutants: [],
    },
    suggestedAction: "add a test",
    acceptanceCheck: { command: `npx @barryzhu/codefog verify src/f${i}.ts`, criteria: [] },
  };
}

function report(overrides: {
  findings?: Finding[];
  warnings?: string[];
  metrics?: Partial<CodefogReport["summary"]["metrics"]>;
}): CodefogReport {
  return {
    $schema: "https://codefog.dev/schemas/v1/report.json",
    version: "1.0.0",
    repository: { name: "demo", branch: "main", commit: "abc1234", generatedAt: "2026-01-01T00:00:00.000Z" },
    summary: {
      trustScore: 37,
      totalFiles: 1,
      totalLoc: 200,
      metrics: {
        lineCoveragePct: 61.5,
        branchCoveragePct: 42.1,
        checkedCoveragePct: 33.3,
        mutationScorePct: 71,
        pseudoTestedMethods: 4,
        contestedOracles: 0,
        coverageAvailable: true,
        mutationAvailable: true,
        ...overrides.metrics,
      },
      locByState: loc({ "fog-returned": 10, fog: 30, "self-proof-fog": 20, "weak-evidence": 100, verified: 40 }),
    },
    modules: [
      {
        path: "src",
        totalFiles: 1,
        verifiedFilesCollapsed: 0,
        trustScore: 52,
        maxRiskScore: 9,
        locByState: loc({ fog: 10 }),
      },
    ],
    findings: overrides.findings ?? [],
    files: [],
    ...(overrides.warnings ? { warnings: overrides.warnings } : {}),
  };
}

function section(html: string, level: number): string {
  const m = new RegExp(`<section id="view-level-${level}"[\\s\\S]*?</section>`).exec(html);
  if (!m) throw new Error(`no level ${level}`);
  return m[0];
}

function metricValue(l1: string, key: string): string {
  const m = new RegExp(`data-metric="${key}"[^>]*>[\\s\\S]*?<span class="metric-val">([^<]*)</span>`).exec(l1);
  if (!m) throw new Error(`no metric ${key}`);
  return m[1];
}

describe("Ticket 38: Level 1 hierarchy, unavailable metrics, Top Findings list and page frame", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefog-t38-"));
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "src", "math.ts"),
      "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
      "utf8",
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("reports coverageAvailable/mutationAvailable in --json and renders — for metrics without data", async () => {
    const out: string[] = [];
    await runCli(["--root", tmpDir, "--json", "--html", path.join(tmpDir, "r.html"), "--fail-on", "none"], {
      stdout: (s) => out.push(s),
      stderr: () => {},
    });
    const json = JSON.parse(out.join(""));
    expect(json.summary.metrics.coverageAvailable).toBe(false);
    expect(json.summary.metrics.mutationAvailable).toBe(false);

    const l1 = section(await fs.readFile(path.join(tmpDir, "r.html"), "utf8"), 1);
    for (const key of ["line-branch", "checked", "pseudo-tested", "mutation"]) {
      expect(metricValue(l1, key)).toBe("—");
    }
    expect(metricValue(l1, "contested")).toBe("0");

    await fs.mkdir(path.join(tmpDir, "coverage"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "coverage", "lcov.info"),
      ["TN:", "SF:src/math.ts", "DA:1,1", "DA:2,1", "LF:2", "LH:2", "end_of_record"].join("\n"),
      "utf8",
    );
    const out2: string[] = [];
    await runCli(["--root", tmpDir, "--json", "--html", path.join(tmpDir, "r.html"), "--fail-on", "none"], {
      stdout: (s) => out2.push(s),
      stderr: () => {},
    });
    expect(JSON.parse(out2.join("")).summary.metrics.coverageAvailable).toBe(true);
    const l1b = section(await fs.readFile(path.join(tmpDir, "r.html"), "utf8"), 1);
    expect(metricValue(l1b, "line-branch")).toBe("100% / 100%");
    expect(metricValue(l1b, "mutation")).toBe("—");
  });

  it("shows the Trust Score once on Level 1 with a five-state bar matching the LOC shares", () => {
    const l1 = section(renderHtmlFogMap(report({})), 1);
    expect(l1.split("37/100").length - 1).toBe(1);
    const card = /<div class="hero-card" data-metric="trust">[\s\S]*?<\/div>\s*<\/div>/.exec(l1)![0];
    const widths = Object.fromEntries(
      [...card.matchAll(/class="bar-seg-([a-z-]+)" style="width:([\d.]+)%"/g)].map((m) => [m[1], Number(m[2])]),
    );
    // 200 LOC: returned 10 (5%), fog 30 (15%), self-proof 20 (10%), weak 100 (50%), verified 40 (20%)
    const expected: Record<string, number> = { returned: 5, fog: 15, "self-proof": 10, weak: 50, verified: 20 };
    for (const [k, v] of Object.entries(expected)) {
      expect(Math.abs(widths[k] - v)).toBeLessThanOrEqual(1);
    }
  });

  it("puts report warnings above the primary cards", () => {
    const l1 = section(renderHtmlFogMap(report({ warnings: ["No coverage report found."] })), 1);
    const warningAt = l1.indexOf('class="report-warning"');
    expect(warningAt).toBeGreaterThan(-1);
    expect(warningAt).toBeLessThan(l1.indexOf('class="hero-card"'));
  });

  it("lists Top Findings compactly: 10 rows by default and a Show all N expander", () => {
    const many = Array.from({ length: 13 }, (_, i) => finding(i + 1, i === 0 ? "fog-returned" : "fog"));
    const l1 = section(renderHtmlFogMap(report({ findings: many })), 1);
    expect(l1).toContain("<h2>Top Findings</h2>");
    const rows = [...l1.matchAll(/<div class="tf-row([^"]*)"/g)].map((m) => m[1]);
    expect(rows).toHaveLength(13);
    expect(rows.filter((c) => !c.includes("hidden"))).toHaveLength(10);
    expect(l1).toContain("Show all 13");
    expect(l1).toContain('data-finding="CF-0001"');
    expect(l1).toContain('class="state-chip chip-fog-returned"');

    const few = section(renderHtmlFogMap(report({ findings: [finding(1)] })), 1);
    expect(few).not.toContain("Show all");
  });

  it("renames Top Fog Hotspots to Top Findings in the HTML, terminal summary and PR comment", async () => {
    const r = report({ findings: [finding(1)] });
    expect(renderHtmlFogMap(r)).not.toContain("Top Fog Hotspots");
    const md = renderPrCommentMarkdown(r);
    expect(md).toContain("### Top Findings");
    expect(md).not.toContain("Top Fog Hotspots");

    await fs.writeFile(
      path.join(tmpDir, "src", "math.test.ts"),
      "import { add } from './math';\nadd(1, 2);\n",
      "utf8",
    );
    await fs.mkdir(path.join(tmpDir, "coverage"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "coverage", "lcov.info"),
      ["TN:", "SF:src/math.ts", "DA:1,0", "DA:2,0", "LF:2", "LH:0", "end_of_record"].join("\n"),
      "utf8",
    );
    const out: string[] = [];
    await runCli(["--root", tmpDir, "--fail-on", "none"], { stdout: (s) => out.push(s), stderr: () => {} });
    const text = out.join("");
    expect(text).toContain("Top Findings:");
    expect(text).not.toContain("Top Fog Hotspots");
  });

  it("replaces the KPI strip on Levels 2-4 with a one-line summary and drops hex values from the legend", () => {
    const html = renderHtmlFogMap(report({}));
    expect(html).not.toContain('class="kpi-strip"');
    for (const level of [2, 3, 4]) {
      expect(section(html, level)).not.toContain("kpi-card");
    }
    const summary = /<div id="level-summary"[^>]*>[\s\S]*?<\/div>\s*<\/div>/.exec(html)![0];
    expect(summary).toContain("37/100");
    expect(summary).toContain("stacked-bar");
    const legend = /<div class="legend">[\s\S]*?<\/div>/.exec(html)![0];
    expect(legend).not.toMatch(/#[0-9A-Fa-f]{6}/);
  });

  it("keeps level labels and Copy as task for agent buttons", () => {
    const html = renderHtmlFogMap(report({ findings: [finding(1)] }));
    for (const label of ["Level 1: Repository", "Level 2: Module", "Level 3: File Map", "Level 4: Source & Evidence"]) {
      expect(html).toContain(label);
    }
    expect(section(html, 1)).toContain("Copy as task for agent");
    expect(html).toContain('"- **Acceptance Check**: " + f.acceptanceCheck.command');
  });
});
