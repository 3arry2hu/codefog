import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runCli } from "../src/cli.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

const SOURCE = [
  "export function add(a: number, b: number): number {",
  "  return a + b;",
  "}",
].join("\n");

const LCOV = [
  "TN:",
  "SF:src/math.ts",
  "FN:1,add",
  "FNF:1",
  "FNH:1",
  "FNDA:1,add",
  "DA:1,1",
  "DA:2,1",
  "LF:2",
  "LH:2",
  "end_of_record",
].join("\n");

async function runDiff(
  rootDir: string,
  extra: string[] = [],
): Promise<{ exitCode: number; report: any; md: string }> {
  const out: string[] = [];
  const outDir = path.join(rootDir, ".codefog");
  const exitCode = await runCli(
    ["--root", rootDir, "--diff", "main", "--pr-comment", outDir, "--json", ...extra],
    { stdout: (s) => out.push(s), stderr: () => {} },
  );
  const md = await fs.readFile(path.join(outDir, "pr-comment.md"), "utf8");
  return { exitCode, report: JSON.parse(out.join("")), md };
}

function metricRow(md: string, label: string): string {
  const row = md.split("\n").find((l) => l.startsWith(`| **${label}** |`));
  if (!row) throw new Error(`missing row ${label}`);
  return row;
}

describe("Ticket 35: --diff marks coverage-derived before-metrics unavailable when the base has no coverage", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefog-t35-"));
    await git(tmpDir, ["init", "-b", "main"]);
    await git(tmpDir, ["config", "user.name", "Test Bot"]);
    await git(tmpDir, ["config", "user.email", "bot@example.com"]);
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "coverage"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "src", "math.ts"), SOURCE, "utf8");
    await fs.writeFile(
      path.join(tmpDir, "README.md"),
      "# Demo\n\nSee `src/math.ts` for the adder.\n",
      "utf8",
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("reports coverageAvailable=false and renders — for every coverage-derived before-metric", async () => {
    await fs.writeFile(path.join(tmpDir, ".gitignore"), "coverage/\n.codefog/\n", "utf8");
    await git(tmpDir, ["add", "."]);
    await git(tmpDir, ["commit", "-m", "base without coverage"]);
    await git(tmpDir, ["checkout", "-b", "feat"]);
    await fs.writeFile(path.join(tmpDir, "coverage", "lcov.info"), LCOV, "utf8");

    const { report, md } = await runDiff(tmpDir, ["--docs", "--fail-on", "none"]);

    expect(report.diff.beforeSummary.coverageAvailable).toBe(false);
    expect(report.summary.metrics.coverageAvailable).toBe(true);

    for (const label of [
      "Trust Score",
      "Line Coverage",
      "Branch Coverage",
      "Checked Coverage",
      "Mutation Score",
      "Pseudo-tested Methods",
    ]) {
      const cells = metricRow(md, label).split("|").map((c) => c.trim());
      expect(cells[2]).toBe("—");
      expect(cells[4]).toBe("—");
    }
    expect(md).toContain(
      "Base coverage unavailable: coverage-derived before-metrics are not compared.",
    );
    expect(md).not.toContain("held steady or improved");

    const docRow = metricRow(md, "Doc Trust Score");
    expect(docRow.split("|")[2].trim()).toBe("100/100");
  });

  it("reports coverageAvailable=true and keeps numeric before-metrics when the base commits coverage", async () => {
    await fs.writeFile(path.join(tmpDir, ".gitignore"), ".codefog/\n", "utf8");
    await fs.writeFile(path.join(tmpDir, "coverage", "lcov.info"), LCOV, "utf8");
    await git(tmpDir, ["add", "."]);
    await git(tmpDir, ["commit", "-m", "base with coverage"]);
    await git(tmpDir, ["checkout", "-b", "feat"]);

    const { report, md } = await runDiff(tmpDir, ["--fail-on", "none"]);

    expect(report.diff.beforeSummary.coverageAvailable).toBe(true);
    expect(metricRow(md, "Line Coverage").split("|")[2].trim()).toBe("100%");
    expect(md).not.toContain("Base coverage unavailable");
  });

  it("keeps the regression gate unchanged when the base has no coverage", async () => {
    await fs.writeFile(path.join(tmpDir, ".gitignore"), "coverage/\n.codefog/\n", "utf8");
    await git(tmpDir, ["add", "."]);
    await git(tmpDir, ["commit", "-m", "base without coverage"]);
    await git(tmpDir, ["checkout", "-b", "feat"]);
    await fs.writeFile(
      path.join(tmpDir, "src", "extra.ts"),
      "export function sub(a: number, b: number): number {\n  return a - b;\n}\n",
      "utf8",
    );
    await fs.writeFile(path.join(tmpDir, "coverage", "lcov.info"), LCOV, "utf8");

    const { exitCode, report } = await runDiff(tmpDir, ["--fail-on", "regression"]);

    expect(report.diff.weakenedFiles).toEqual(["src/extra.ts"]);
    expect(exitCode).toBe(1);
  });
});
