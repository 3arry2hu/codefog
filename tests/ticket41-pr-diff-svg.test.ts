import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runCli } from "../src/cli.js";
import { renderPrCommentMarkdown, renderPrDiffSvg } from "../src/diff-pr.js";
import type { CodefogReport, DiffComparison, FileSummary, LocByState } from "../src/types.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

function loc(partial: Partial<LocByState>): LocByState {
  return { "fog-returned": 0, fog: 0, "self-proof-fog": 0, "weak-evidence": 0, verified: 0, ...partial };
}

function file(p: string, byState: Partial<LocByState>, riskScore: number, diffStatus?: FileSummary["diffStatus"]): FileSummary {
  const l = loc(byState);
  const totalLoc = Object.values(l).reduce((a, b) => a + b, 0);
  return {
    path: p,
    modulePath: "src",
    totalLoc,
    unverifiedLoc: totalLoc - l.verified,
    dominantState: l["fog-returned"] > 0 ? "fog-returned" : l.fog > 0 ? "fog" : "weak-evidence",
    trustScore: 40,
    riskScore,
    churn90d: 0,
    cyclomaticComplexity: 1,
    locByState: l,
    lines: [],
    lineStates: {},
    regions: [],
    ...(diffStatus ? { diffStatus } : {}),
  };
}

function report(files: FileSummary[], diff: Partial<DiffComparison>, docs = false): CodefogReport {
  return {
    $schema: "https://codefog.dev/schemas/v1/report.json",
    version: "1.0.0",
    repository: { name: "demo", branch: "feat", commit: "abc1234", generatedAt: "2026-01-01T00:00:00.000Z" },
    summary: {
      trustScore: 40,
      ...(docs ? { docTrustScore: 30, totalDocClaims: 4, docClaimsByState: loc({ fog: 4 }) } : {}),
      totalFiles: files.length,
      totalLoc: 100,
      metrics: {
        lineCoveragePct: 80,
        branchCoveragePct: 70,
        checkedCoveragePct: 60,
        mutationScorePct: 0,
        pseudoTestedMethods: 1,
        contestedOracles: 0,
        coverageAvailable: true,
      },
      locByState: loc({ fog: 100 }),
    },
    modules: [],
    findings: [],
    files,
    diff: {
      baseRef: "main",
      coverageUpEvidenceDown: false,
      alertHeadline: "headline",
      fogReturnedFiles: [],
      weakenedFiles: [],
      changedFiles: files.map((f) => f.path),
      beforeSummary: {
        trustScore: 35,
        ...(docs ? { docTrustScore: 60 } : {}),
        coverageAvailable: true,
        metrics: {
          lineCoveragePct: 70,
          branchCoveragePct: 70,
          checkedCoveragePct: 60,
          mutationScorePct: 0,
          pseudoTestedMethods: 1,
          contestedOracles: 0,
        },
        files: files.map((f) => ({
          path: f.path,
          modulePath: "src",
          totalLoc: f.totalLoc,
          dominantState: "fog",
          riskScore: f.riskScore,
          trustScore: 30,
          locByState: loc({ fog: f.totalLoc }),
        })),
      },
      ...diff,
    },
  };
}

function svgRows(svg: string): string[] {
  return [...svg.matchAll(/<g class="row" data-path="([^"]+)"/g)].map((m) => m[1]);
}

function svgSize(svg: string): { width: number; height: number } {
  const m = /<svg[^>]*width="(\d+)" height="(\d+)"/.exec(svg)!;
  return { width: Number(m[1]), height: Number(m[2]) };
}

describe("Ticket 41: PR diff SVG by changed file and PR comment fixes", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefog-t41-"));
    await git(tmpDir, ["init", "-b", "main"]);
    await git(tmpDir, ["config", "user.name", "Test Bot"]);
    await git(tmpDir, ["config", "user.email", "bot@example.com"]);
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("draws one row per changed file and flags new files", async () => {
    const fn = (name: string, body: string) => `export function ${name}(a: number): number {\n  return ${body};\n}\n`;
    for (const n of ["a", "b", "c", "d"]) {
      await fs.writeFile(path.join(tmpDir, "src", `${n}.ts`), fn(n, "a + 1"), "utf8");
    }
    await fs.writeFile(path.join(tmpDir, ".gitignore"), ".codefog/\n", "utf8");
    await git(tmpDir, ["add", "."]);
    await git(tmpDir, ["commit", "-m", "base"]);
    await git(tmpDir, ["checkout", "-b", "feat"]);
    await fs.writeFile(path.join(tmpDir, "src", "a.ts"), fn("a", "a + 2"), "utf8");
    await fs.writeFile(path.join(tmpDir, "src", "b.ts"), fn("b", "a * 2"), "utf8");
    await fs.writeFile(path.join(tmpDir, "src", "e.ts"), fn("e", "a - 1"), "utf8");

    const out: string[] = [];
    await runCli(["--root", tmpDir, "--diff", "main", "--pr-comment", ".codefog", "--json", "--fail-on", "none"], {
      stdout: (s) => out.push(s),
      stderr: () => {},
    });
    const json = JSON.parse(out.join(""));
    expect([...json.diff.changedFiles].sort()).toEqual(["src/a.ts", "src/b.ts", "src/e.ts"]);

    const svg = await fs.readFile(path.join(tmpDir, ".codefog", "pr-diff.svg"), "utf8");
    expect(svgRows(svg).sort()).toEqual(["src/a.ts", "src/b.ts", "src/e.ts"]);
    const newRow = /<g class="row" data-path="src\/e\.ts"[\s\S]*?<\/g>\s*<\/g>/.exec(svg)![0];
    expect(newRow).toContain(">NEW<");
    const oldRow = /<g class="row" data-path="src\/a\.ts"[\s\S]*?<\/g>\s*<\/g>/.exec(svg)![0];
    expect(oldRow).not.toContain(">NEW<");
    expect(svg).not.toContain("Treemap");
  });

  it("caps the SVG at 10 rows, always keeps Fog Returned files, and grows with the row count", () => {
    const files = Array.from({ length: 15 }, (_, i) => file(`src/f${String(i).padStart(2, "0")}.ts`, { fog: 10 }, 9 - i * 0.5));
    files[14] = file("src/returned.ts", { "fog-returned": 3, fog: 7 }, 0.1, "fog-returned");
    const big = renderPrDiffSvg(
      report(files, { fogReturnedFiles: ["src/returned.ts"] }),
    );
    const rows = svgRows(big);
    expect(rows).toHaveLength(10);
    expect(rows).toContain("src/returned.ts");
    expect(big).toContain("+5 more files");

    const small = renderPrDiffSvg(report(files.slice(0, 2), {}));
    expect(svgRows(small)).toHaveLength(2);
    expect(svgSize(big).height).toBeGreaterThan(svgSize(small).height);

    for (const svg of [big, small]) {
      const { width, height } = svgSize(svg);
      for (const m of svg.matchAll(/<text[^>]* x="([\d.]+)" y="([\d.]+)"/g)) {
        expect(Number(m[1])).toBeLessThanOrEqual(width);
        expect(Number(m[2])).toBeLessThanOrEqual(height);
      }
      for (const m of svg.matchAll(/<g [^>]*transform="translate\(([\d.]+), ([\d.]+)\)"/g)) {
        expect(Number(m[2])).toBeLessThan(height);
      }
    }
  });

  it("draws before bars and deltas only when the base had coverage", () => {
    const files = [file("src/a.ts", { fog: 4, verified: 6 }, 3)];
    const withBase = renderPrDiffSvg(report(files, {}));
    expect(withBase).toContain('class="bar-before"');
    expect(withBase).toContain("+10");
    expect(withBase).not.toContain("Base coverage unavailable");

    const noBase = report(files, {});
    noBase.diff!.beforeSummary.coverageAvailable = false;
    const svg = renderPrDiffSvg(noBase);
    expect(svg).toContain("Base coverage unavailable: before-states not compared");
    expect(svg).not.toContain('class="bar-before"');
  });

  it("keeps the PR comment wording consistent with the data and uses GitHub alert blocks", () => {
    const weakenedOnly = renderPrCommentMarkdown(
      report([file("src/a.ts", { fog: 10 }, 3, "weakened")], {
        weakenedFiles: ["src/a.ts"],
        alertHeadline: "Evidence weakened against main: 1 weakened file(s), no Fog Returned.",
      }),
    );
    expect(weakenedOnly).not.toContain("Fog Returned detected");
    expect(weakenedOnly).not.toMatch(/^> [ℹ⚠]/mu);

    const returned = renderPrCommentMarkdown(
      report([file("src/a.ts", { "fog-returned": 2 }, 3, "fog-returned")], {
        fogReturnedFiles: ["src/a.ts"],
        alertHeadline: "Fog Returned detected against main: 1 file(s) with Fog Returned, 0 weakened file(s).",
      }),
    );
    expect(returned).toContain("> [!WARNING]\n> **Fog Returned detected against main");
  });

  it("writes each Before value once: separate Before, After and Δ columns, and no duplicate Doc Trust line", () => {
    const md = renderPrCommentMarkdown(report([file("src/a.ts", { fog: 10 }, 3)], {}, true));
    expect(md).toContain("| Metric | Before (main) | After (PR) | Δ |");
    expect(md).toContain("| **Trust Score** | 35/100 | **40/100** | +5 |");
    expect(md).toContain("| **Doc Trust Score** | 60/100 | **30/100** | -30 |");
    expect(md).toContain("| **Line Coverage** | 70% | **80%** | +10% |");
    expect(md.match(/Doc Trust Score/g)).toHaveLength(1);
  });

  it("derives the headline from the data: no 'Fog Returned detected' with zero returned files", async () => {
    const fn = (body: string) => `export function a(x: number): number {\n  return ${body};\n}\n`;
    await fs.writeFile(path.join(tmpDir, "src", "a.ts"), fn("x + 1"), "utf8");
    await fs.writeFile(path.join(tmpDir, ".gitignore"), ".codefog/\n", "utf8");
    await git(tmpDir, ["add", "."]);
    await git(tmpDir, ["commit", "-m", "base"]);
    await git(tmpDir, ["checkout", "-b", "feat"]);
    await fs.writeFile(path.join(tmpDir, "src", "new.ts"), fn("x * 3"), "utf8");

    const out: string[] = [];
    const exitCode = await runCli(
      ["--root", tmpDir, "--diff", "main", "--pr-comment", ".codefog", "--json", "--fail-on", "regression"],
      { stdout: (s) => out.push(s), stderr: () => {} },
    );
    const json = JSON.parse(out.join(""));
    expect(json.diff.fogReturnedFiles).toEqual([]);
    expect(json.diff.weakenedFiles).toEqual(["src/new.ts"]);
    expect(exitCode).toBe(1);
    expect(json.diff.alertHeadline).not.toContain("Fog Returned detected");
    const md = await fs.readFile(path.join(tmpDir, ".codefog", "pr-comment.md"), "utf8");
    expect(md).not.toContain("Fog Returned detected");
    expect(md).toContain("> [!WARNING]");
  });
});
