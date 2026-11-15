import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { formatLevel1Summary, runCli } from "../src/cli.js";
import {
  STATE_BAR_GLYPHS,
  STATE_BAR_WIDTH,
  TERMINAL_MAX_COLUMNS,
  formatLevel1SummaryColor,
  shouldUseColor,
  stateBarCells,
  stripAnsi,
} from "../src/terminal-summary.js";
import type { CodefogReport, Finding, LocByState } from "../src/types.js";

const ESC = "\x1b[";

const SOURCE = [
  "export function add(a: number, b: number): number {",
  "  return a + b;",
  "}",
  "",
  "export function sub(a: number, b: number): number {",
  "  if (a > b) {",
  "    return a - b;",
  "  }",
  "  return b - a;",
  "}",
].join("\n");

const LCOV = [
  "TN:",
  "SF:src/math.ts",
  "FN:1,add",
  "FN:5,sub",
  "FNF:2",
  "FNH:1",
  "FNDA:1,add",
  "FNDA:0,sub",
  "DA:1,1",
  "DA:2,1",
  "DA:5,0",
  "DA:6,0",
  "DA:7,0",
  "DA:9,0",
  "LF:6",
  "LH:2",
  "end_of_record",
].join("\n");

async function run(argv: string[], color?: boolean): Promise<{ code: number; out: string }> {
  const out: string[] = [];
  const io = { stdout: (s: string) => out.push(s), stderr: () => {} };
  const code = await runCli(argv, color === undefined ? io : { ...io, color });
  return { code, out: out.join("") };
}

function loc(partial: Partial<LocByState>): LocByState {
  return { "fog-returned": 0, fog: 0, "self-proof-fog": 0, "weak-evidence": 0, verified: 0, ...partial };
}

describe("Ticket 42: colored terminal summary on TTY only", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefog-t42-"));
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "src", "math.ts"), SOURCE, "utf8");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("without color the summary is exactly formatLevel1Summary and carries no ANSI", async () => {
    const plain = await run(["--root", tmpDir]);
    const json = await run(["--root", tmpDir, "--json"]);
    const report = JSON.parse(json.out) as CodefogReport;
    report.repository.generatedAt = "";
    expect(plain.out).not.toContain(ESC);
    expect(plain.out).toBe(formatLevel1Summary(report));
    const explicitOff = await run(["--root", tmpDir], false);
    expect(explicitOff.out).toBe(plain.out);
  });

  it("--json output is the same with and without color", async () => {
    const off = await run(["--root", tmpDir, "--json"]);
    const on = await run(["--root", tmpDir, "--json"], true);
    const strip = (s: string) => {
      const r = JSON.parse(s);
      r.repository.generatedAt = "";
      return r;
    };
    expect(on.out).not.toContain(ESC);
    expect(strip(on.out)).toEqual(strip(off.out));
    expect(on.code).toBe(off.code);
  });

  it("color: ANSI, a five-state bar, the fog map path, and no line over 100 visible columns", async () => {
    await fs.mkdir(path.join(tmpDir, "coverage"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "coverage", "lcov.info"), LCOV, "utf8");
    const { out } = await run(["--root", tmpDir], true);
    expect(out).toContain(ESC);
    const lines = stripAnsi(out).split("\n");
    const trustLine = lines.find((l) => l.startsWith("Trust"))!;
    const bar = trustLine.replace(/^Trust\s+\d+\/100\s+/, "");
    expect([...bar]).toHaveLength(STATE_BAR_WIDTH);
    expect([...bar].every((ch) => Object.values(STATE_BAR_GLYPHS).includes(ch))).toBe(true);
    const mapLine = lines.find((l) => l.startsWith("Fog Map"))!;
    expect(mapLine).toBeDefined();
    expect(path.resolve(mapLine.replace(/^Fog Map\s+/, ""))).toBe(path.join(tmpDir, ".codefog", "report.html"));
    for (const line of lines) expect([...line].length).toBeLessThanOrEqual(TERMINAL_MAX_COLUMNS);
    const metrics = lines.find((l) => l.startsWith("Metrics"))!;
    expect(metrics).toMatch(/Line \d[\d.]*%  Branch \d[\d.]*%/);
    expect(metrics).toMatch(/Mutation —/);
  });

  it("color without coverage shows — for Line and Branch", async () => {
    const { out } = await run(["--root", tmpDir], true);
    const metrics = stripAnsi(out).split("\n").find((l) => l.startsWith("Metrics"))!;
    expect(metrics).toMatch(/Line —/);
    expect(metrics).toMatch(/Branch —/);
    expect(metrics).toMatch(/Mutation —/);
  });

  it("aligns Top Findings columns and middle-truncates long paths within 100 columns", () => {
    const longPath = `src/${"deeply/nested/".repeat(8)}module-with-a-long-name.ts`;
    const mkFinding = (id: string, file: string, state: Finding["state"], risk: number): Finding => ({
      id,
      title: "A function title that keeps going ".repeat(4),
      state,
      riskScore: risk,
      agentReady: true,
      location: { file, symbol: "fn", startLine: 10, endLine: 120 },
      reason: "",
      evidence: {
        executedByTests: 0,
        assertionsOnOutcome: 0,
        pseudoTested: false,
        oracleContest: false,
        oracleIds: [],
        missedBoundary: false,
        survivingMutants: [],
      },
      suggestedAction: "",
      acceptanceCheck: { command: "", criteria: [] },
    });
    const report = {
      repository: { name: "x".repeat(150), branch: "main", commit: "abc1234", generatedAt: "" },
      summary: {
        trustScore: 12,
        totalFiles: 2,
        totalLoc: 300,
        locByState: loc({ "fog-returned": 3, fog: 200, "weak-evidence": 90, verified: 7 }),
        metrics: {
          lineCoveragePct: 10,
          branchCoveragePct: 5,
          checkedCoveragePct: 1,
          mutationScorePct: 0,
          pseudoTestedMethods: 0,
          contestedOracles: 0,
        },
      },
      modules: [
        { path: longPath, trustScore: 12, maxRiskScore: 9.9, locByState: loc({ fog: 99999, "weak-evidence": 99999, verified: 99999 }) },
      ],
      findings: [
        mkFinding("CF-0001", longPath, "fog-returned", 9.9),
        mkFinding("CF-0002", "src/a.ts", "weak-evidence", 3.25),
      ],
    } as unknown as CodefogReport;
    const lines = stripAnsi(formatLevel1SummaryColor(report, "/elsewhere/report.html", "/repo")).split("\n");
    for (const line of lines) expect([...line].length).toBeLessThanOrEqual(TERMINAL_MAX_COLUMNS);
    const rows = lines.filter((l) => l.startsWith("  CF-"));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("…");
    expect(rows[0]).toMatch(/^ {2}CF-0001 {2}src\/deeply\/.*….*\.ts:10-120 /);
    const col = (row: string, token: string) => row.indexOf(token);
    expect(col(rows[0]!, "fog-returned")).toBe(col(rows[1]!, "weak-evidence"));
    expect(lines.at(-2)).toContain("/elsewhere/report.html");
  });

  it("stateBarCells fills the fixed width and keeps any non-empty state visible", () => {
    const cells = stateBarCells(loc({ "fog-returned": 1, fog: 5000, verified: 4999 }));
    expect(Object.values(cells).reduce((a, b) => a + b, 0)).toBe(STATE_BAR_WIDTH);
    expect(cells["fog-returned"]).toBe(1);
  });

  it("bin.ts only asks for color on a TTY without NO_COLOR", async () => {
    expect(shouldUseColor(true, {})).toBe(true);
    expect(shouldUseColor(true, { NO_COLOR: "1" })).toBe(false);
    expect(shouldUseColor(false, {})).toBe(false);
    expect(shouldUseColor(undefined, {})).toBe(false);
    const bin = await fs.readFile(path.join(__dirname, "..", "src", "bin.ts"), "utf8");
    expect(bin).toContain("color: shouldUseColor(process.stdout.isTTY, process.env)");
  });

  it("does not add runtime dependencies", async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(__dirname, "..", "package.json"), "utf8"));
    expect(pkg.dependencies).toEqual({ typescript: "^5.8.2" });
  });
});
