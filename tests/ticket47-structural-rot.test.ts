import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeRepository, computeRiskScore, type CodefogReport } from "../src/index.js";
import { formatLevel1Summary, runCli } from "../src/cli.js";

const execFileAsync = promisify(execFile);

function nestedFunction(name: string): string {
  return [
    `export function ${name}(value: number) {`,
    ...Array.from({ length: 6 }, (_, depth) => `${"  ".repeat(depth + 1)}if (value > ${depth}) {`),
    "              return value;",
    ...Array.from({ length: 6 }, (_, index) => `${"  ".repeat(6 - index)}}`),
    "  return 0;",
    "}",
  ].join("\n");
}

const SHARED_BLOCK = [
  "let sum = 3;",
  "sum = sum + 12;",
  "sum = sum * 8;",
  "sum = sum % 23;",
  "sum = sum - 4;",
  "sum = sum / 16;",
  "sum = sum ** 3;",
  "sum = sum * 6;",
];

function withSharedBlock(name: string, result: number, comments = false): string {
  return [
    `export function ${name}() {`,
    ...SHARED_BLOCK.map((line) => comments ? `    ${line.replace(/\s*([=+*%\-/]+)\s*/g, "$1")} /* same logic */` : `  ${line}`),
    `  return sum + ${result};`,
    "}",
  ].join("\n");
}

describe("Ticket #47: Code structure, short-term churn, and diff regressions", () => {
  let rootDir: string;

  async function git(...args: string[]): Promise<void> {
    await execFileAsync("git", args, { cwd: rootDir });
  }

  async function write(file: string, source: string): Promise<void> {
    const absolute = path.join(rootDir, file);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, `${source}\n`, "utf8");
  }

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefog-t47-"));
    await git("init", "-b", "main");
    await git("config", "user.name", "Test Bot");
    await git("config", "user.email", "tests@example.com");
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("adds hotspot risk and counts only recent changes without changing evidence", async () => {
    const source = [
      "// Report header",
      "export function simple(value: number) { return value; }",
      nestedFunction("nested"),
    ].join("\n");
    await write("src/engineering.ts", source);
    await git("add", ".");
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    await execFileAsync("git", ["commit", "-m", "Old revision"], {
      cwd: rootDir,
      env: { ...process.env, GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old },
    });
    await write("src/engineering.ts", `${source}\n// Recent edit`);
    await git("commit", "-am", "First recent revision");
    await write("src/engineering.ts", `${source}\n// Second recent edit`);
    await git("commit", "-am", "Second recent revision");

    const report = await analyzeRepository({ rootDir });
    const file = report.files.find((row) => row.path === "src/engineering.ts")!;
    const simple = file.regions.find((region) => region.symbol === "simple")!;
    const nested = file.regions.find((region) => region.symbol === "nested")!;
    const originalRisk = (region: typeof simple) => computeRiskScore({
      unverifiedLoc: region.loc,
      churn90d: file.churn90d,
      cyclomaticComplexity: region.cyclomaticComplexity,
      state: "fog",
    });
    expect(file.churn90d).toBe(3);
    expect(file.shortTermChurn14d).toBe(2);
    expect(simple).toMatchObject({ cognitiveComplexity: 0, maxNestingDepth: 0, riskScore: originalRisk(simple) });
    expect(nested).toMatchObject({ cognitiveComplexity: 21, maxNestingDepth: 6 });
    expect(nested.riskScore).toBeGreaterThan(originalRisk(nested));
    expect(report.findings.find((finding) => finding.title === "nested")?.evidence).toMatchObject({
      cognitiveComplexity: 21,
      maxNestingDepth: 6,
    });
    expect(report.summary.trustScore).toBe(0);
    expect(report.summary.locByState).toMatchObject({ fog: simple.loc + nested.loc, verified: 0 });

    const originalFileRisk = computeRiskScore({
      unverifiedLoc: file.unverifiedLoc,
      churn90d: file.churn90d,
      cyclomaticComplexity: file.cyclomaticComplexity,
      state: file.dominantState,
    });
    expect(file.riskScore).toBeGreaterThan(originalFileRisk);
    const beforeStructureBoost = formatLevel1Summary({
      ...report,
      modules: [{ ...report.modules[0]!, maxRiskScore: originalFileRisk }],
      findings: report.findings.map((finding) => ({
        ...finding,
        riskScore: finding.title === "nested" ? originalRisk(nested) : originalRisk(simple),
      })),
    });
    const out: string[] = [];
    expect(await runCli(["--root", rootDir], {
      stdout: (line) => out.push(line), stderr: () => {},
    })).toBe(0);
    expect(out.join("")).toBe(beforeStructureBoost);
  });

  it("marks an unused export and foggy regions in an unused file before recommending tests", async () => {
    await write("src/exports.ts", "export function kept() { return 1; }\nexport function unused() { return 2; }");
    await write("src/unused-file.ts", "// offset\nexport function nobodyUsesThis() { return 3; }");
    await write("knip.json", JSON.stringify({
      files: ["src/unused-file.ts"],
      issues: [{ file: "src/exports.ts", exports: ["unused"] }],
    }));

    const plain = await analyzeRepository({ rootDir, docs: true });
    const out: string[] = [];
    expect(await runCli(["--root", rootDir, "--knip", "knip.json", "--docs", "--json"], {
      stdout: (line) => out.push(line), stderr: () => {},
    })).toBe(0);
    const report = JSON.parse(out.join("")) as CodefogReport;
    const byTitle = (title: string) => report.findings.find((finding) => finding.title === title)!;
    expect(byTitle("unused").tags).toContain("dead-code-fog");
    expect(byTitle("nobodyUsesThis").tags).toContain("dead-code-fog");
    expect(byTitle("unused").suggestedAction).toContain("remove the dead code");
    expect(byTitle("kept").tags ?? []).not.toContain("dead-code-fog");
    expect(report.summary.trustScore).toBe(plain.summary.trustScore);
    expect(report.summary.locByState).toEqual(plain.summary.locByState);
  });

  it("reports net new complexity, error masking, and normalized duplicate blocks without base coverage", async () => {
    const tsFile = "src/feature/main.ts";
    const duplicate = "src/feature/with space.ts";
    const retainedCatch = [
      "export function oldCatch() {",
      "  try { keep(); } catch {}",
      "}",
    ].join("\n");
    await write(tsFile, `export function feature(value: number) { return value; }\n${retainedCatch}`);
    await write("src/shared/original.ts", withSharedBlock("original", 100));
    await write("src/shared/legacy-copy.ts", withSharedBlock("legacyCopy", 101));
    await write(duplicate, "export const retained = 1;");
    await write("cmd/run.go", "package main\nfunc Run() { var err error; if err != nil {} }");
    await write("crates/core/lib.rs", "pub fn parse() -> i32 { 1 }");
    await git("add", ".");
    await git("commit", "-m", "Baseline with old masking and duplication");

    await write(tsFile, [
      nestedFunction("feature"),
      "// Existing catch remains after a rename",
      retainedCatch.replace("oldCatch", "renamedCatch"),
      "export function newCatch() { try { recoverable(); } catch {} }",
    ].join("\n"));
    await write(duplicate, `export const retained = 1;\n${withSharedBlock("newCopy", 102, true)}`);
    await write("cmd/run.go", [
      "package main",
      "func Run() {",
      "  var err error",
      "  if err != nil {}",
      "  _ = err",
      "}",
    ].join("\n"));
    await write("crates/core/lib.rs", [
      "pub fn parse() -> i32 {",
      "    Some(1).unwrap()",
      "}",
      "#[cfg(test)]",
      "mod tests {",
      "    #[test]",
      "    fn parses() { Some(1).unwrap(); }",
      "}",
    ].join("\n"));
    await git("commit", "-am", "Introduce regressions");

    const out: string[] = [];
    const errors: string[] = [];
    expect(await runCli(["--root", rootDir, "--diff", "HEAD~1", "--json"], {
      stdout: (line) => out.push(line), stderr: (line) => errors.push(line),
    }), errors.join("")).toBe(0);
    const report = JSON.parse(out.join("")) as CodefogReport;
    expect(report.diff?.beforeSummary.coverageAvailable).toBe(false);
    expect(report.diff?.structuralRot).toEqual({
      complexitySpikes: [{ file: tsFile, symbol: "feature", line: 1, before: 0, after: 21, delta: 21 }],
      addedErrorMasking: [
        { file: "cmd/run.go", line: 5, pattern: "discarded-error" },
        { file: "crates/core/lib.rs", line: 2, pattern: "unwrap" },
        { file: tsFile, line: 21, pattern: "empty-catch" },
      ],
      addedDuplicatedBlocks: [{
        file: duplicate,
        startLine: 3,
        endLine: 10,
        duplicateFile: "src/shared/legacy-copy.ts",
        duplicateStartLine: 2,
        duplicateEndLine: 9,
      }],
    });
  });
});
