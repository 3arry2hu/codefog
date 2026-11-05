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

describe("Ticket 21: Doc Layer in Interactive Fog Map (report.html) and PR Diff Report (pr-comment.md)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefog-t21-"));
    await git(tmpDir, ["init", "-b", "main"]);
    await git(tmpDir, ["config", "user.name", "Test Bot"]);
    await git(tmpDir, ["config", "user.email", "bot@example.com"]);

    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "tests"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "docs"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "coverage"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("renders Level 1 dual Trust Scores, Level 2 docs group with exact state counts matching --json, and Level 3 doc tiles weighted by claim count when --docs is enabled, while keeping HTML unchanged without --docs", async () => {
    const feeFile = path.join(tmpDir, "src", "fee.ts");
    const testFile = path.join(tmpDir, "tests", "fee.test.ts");
    const lcovFile = path.join(tmpDir, "coverage", "lcov.info");
    const readmeFile = path.join(tmpDir, "README.md");
    const guideFile = path.join(tmpDir, "docs", "guide.md");

    // Commit 1: add src/fee.ts first so test in Commit 2 is not same-commit self-proof-fog
    await fs.writeFile(
      feeFile,
      [
        "export function calculateFee(amount: number): number {",
        "  return amount * 2;",
        "}",
        "",
        "export function taxFee(amount: number): number {",
        "  return amount * 10;",
        "}",
      ].join("\n"),
      "utf8",
    );
    await git(tmpDir, ["add", "src/fee.ts"]);
    await git(tmpDir, ["commit", "-m", "feat: add fee module"]);

    // Commit 2: add strong test for calculateFee (2 LOC verified), leave taxFee uncovered (2 LOC fog)
    // Code Trust Score = round((2 * 1.0 + 2 * 0.0) / 4 * 100) = 50
    await fs.writeFile(
      testFile,
      [
        "import { describe, it, expect } from 'vitest';",
        "import { calculateFee } from '../src/fee.js';",
        "describe('fee', () => {",
        "  it('calculates fee', () => {",
        "    expect(calculateFee(5)).toBe(10);",
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
        "FN:5,taxFee",
        "FNF:2",
        "FNH:1",
        "FNDA:1,calculateFee",
        "FNDA:0,taxFee",
        "DA:1,1",
        "DA:2,1",
        "DA:5,0",
        "DA:6,0",
        "LF:4",
        "LH:2",
        "end_of_record",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      guideFile,
      [
        "# Guide",
        "",
        "Check `taxFee` inside `src/fee.ts`.",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      readmeFile,
      [
        "# Billing Docs",
        "",
        "Read [Guide](docs/guide.md) before calling `calculateFee`.",
        "",
        "Build output is in `dist/bundle.js`, while `docs/missing.md` was removed.",
      ].join("\n"),
      "utf8",
    );
    await git(tmpDir, ["add", "."]);
    await git(tmpDir, ["commit", "-m", "test: verify calculateFee and add docs"]);

    // 1. Without --docs: HTML must NOT contain Doc Trust Score, docs module, or doc files
    const exitNoDocs = await runCli(["--root", tmpDir, "--fail-on", "none"], {
      stdout: () => {},
      stderr: () => {},
    });
    expect(exitNoDocs).toBe(0);
    const htmlNoDocs = await fs.readFile(path.join(tmpDir, ".codefog", "report.html"), "utf8");
    expect(htmlNoDocs).toContain("50/100");
    expect(htmlNoDocs).not.toContain("Doc Trust Score");
    expect(htmlNoDocs).not.toContain("docClaims");
    expect(htmlNoDocs).not.toContain("docFiles");
    expect(htmlNoDocs).not.toContain("Claims:");
    expect(htmlNoDocs).not.toContain("README.md");
    expect(htmlNoDocs).not.toContain("docs/guide.md");

    // 2. With --docs:
    // Guide claims (2): `taxFee` (weak-evidence), `src/fee.ts` (verified)
    // README claims (4): `docs/guide.md` (verified), `calculateFee` (weak-evidence), `dist/bundle.js` (fog), `docs/missing.md` (fog-returned)
    // Total claims = 6: verified=2 (+2.0), weak-evidence=2 (+0.8), fog=1 (0), fog-returned=1 (-0.5)
    // Weighted = 2.3 / 6 = 0.3833 -> Doc Trust Score = 38
    const report = await analyzeRepository({ rootDir: tmpDir, docs: true });
    expect(report.summary.trustScore).toBe(50);
    expect(report.summary.docTrustScore).toBe(38);
    expect(report.summary.docClaimsByState).toEqual({
      "fog-returned": 1,
      fog: 1,
      "self-proof-fog": 0,
      "weak-evidence": 2,
      verified: 2,
    });

    const exitDocs = await runCli(["--root", tmpDir, "--docs", "--fail-on", "none"], {
      stdout: () => {},
      stderr: () => {},
    });
    expect(exitDocs).toBe(0);
    const htmlDocs = await fs.readFile(path.join(tmpDir, ".codefog", "report.html"), "utf8");

    // Level 1: both Trust Score (50/100) and Doc Trust Score (38/100) literal values
    expect(htmlDocs).toContain("Trust Score");
    expect(htmlDocs).toContain("50/100");
    expect(htmlDocs).toContain("Doc Trust Score");
    expect(htmlDocs).toContain("38/100");

    // Level 2: docs module group with state counts matching --json
    const level2Match = /<section id="view-level-2"[\s\S]*?<\/section>/.exec(htmlDocs);
    expect(level2Match).not.toBeNull();
    const level2Html = level2Match![0];
    expect(level2Html).toContain('data-module="docs"');
    expect(level2Html).toContain("fog-returned: 1");
    expect(level2Html).toContain("fog: 1");
    expect(level2Html).toContain("self-proof-fog: 0");
    expect(level2Html).toContain("weak-evidence: 2");
    expect(level2Html).toContain("verified: 2");

    // Level 3: doc files participate in treemap with area calculated by claim count (README.md = 4, docs/guide.md = 2)
    const level3Match = /<section id="view-level-3"[\s\S]*?<\/section>/.exec(htmlDocs);
    expect(level3Match).not.toBeNull();
    const level3Html = level3Match![0];
    expect(level3Html).toContain("README.md");
    expect(level3Html).toContain("Claims: 4");
    expect(level3Html).toContain('data-claims="4"');
    expect(level3Html).toContain("flex:4 1");
    expect(level3Html).toContain("docs/guide.md");
    expect(level3Html).toContain("Claims: 2");
    expect(level3Html).toContain('data-claims="2"');
    expect(level3Html).toContain("flex:2 1");
  });

  it("renders Level 4 doc lines with 5-state highlighting, RETURNED badge (#BD4900) on fog-returned claims, referent file path, and referent lastModifiedCommit short SHA", async () => {
    const feeFile = path.join(tmpDir, "src", "fee.ts");
    const lcovFile = path.join(tmpDir, "coverage", "lcov.info");
    const readmeFile = path.join(tmpDir, "README.md");
    const guideFile = path.join(tmpDir, "docs", "guide.md");

    // Commit A: initial synchronized code and docs
    await fs.writeFile(
      feeFile,
      [
        "export function calculateFee(amount: number): number {",
        "  return amount * 0.02;",
        "}",
        "",
        "export function taxFee(amount: number): number {",
        "  return amount * 0.1;",
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
        "FN:5,taxFee",
        "FNF:2",
        "FNH:2",
        "FNDA:1,calculateFee",
        "FNDA:1,taxFee",
        "DA:1,1",
        "DA:2,1",
        "DA:5,1",
        "DA:6,1",
        "LF:4",
        "LH:4",
        "end_of_record",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(guideFile, "# Guide\n\nWelcome.\n", "utf8");
    await fs.writeFile(
      readmeFile,
      [
        "# Billing",
        "",
        "Call `calculateFee` to compute processing fees.",
        "Call `taxFee` to compute tax.",
        "See [Guide](docs/guide.md) or generated `dist/bundle.js`.",
      ].join("\n"),
      "utf8",
    );
    await git(tmpDir, ["add", "."]);
    await git(tmpDir, ["commit", "-m", "feat: add fee module and README"]);
    const commitAShort = await git(tmpDir, ["rev-parse", "--short", "HEAD"]);

    // Commit B: change calculateFee runtime logic in src/fee.ts without updating README.md
    await fs.writeFile(
      feeFile,
      [
        "export function calculateFee(amount: number): number {",
        "  return Math.round(amount * 0.05 + 25);",
        "}",
        "",
        "export function taxFee(amount: number): number {",
        "  return amount * 0.1;",
        "}",
      ].join("\n"),
      "utf8",
    );
    await git(tmpDir, ["add", "src/fee.ts"]);
    await git(tmpDir, ["commit", "-m", "feat: change calculateFee formula"]);
    const commitBShort = await git(tmpDir, ["rev-parse", "--short", "HEAD"]);

    const exitCode = await runCli(["--root", tmpDir, "--docs", "--fail-on", "none"], {
      stdout: () => {},
      stderr: () => {},
    });
    expect(exitCode).toBe(0);

    const html = await fs.readFile(path.join(tmpDir, ".codefog", "report.html"), "utf8");
    const level4Match = /<section id="view-level-4"[\s\S]*?<\/section>/.exec(html);
    expect(level4Match).not.toBeNull();
    const level4Html = level4Match![0];

    // Line 3: `calculateFee` is in fog-returned -> line-fog-returned, RETURNED badge, referent path src/fee.ts, and commitBShort
    const returnedLineMatch = /<tr class="line-fog-returned">[\s\S]*?<\/tr>/.exec(level4Html);
    expect(returnedLineMatch).not.toBeNull();
    const returnedLineHtml = returnedLineMatch![0];
    expect(returnedLineHtml).toContain("Call `calculateFee` to compute processing fees.");
    expect(returnedLineHtml).toContain('<span class="badge-returned">RETURNED</span>');
    expect(returnedLineHtml).toContain("src/fee.ts");
    expect(returnedLineHtml).toContain(commitBShort);

    // Line 4: `taxFee` is in weak-evidence -> line-weak-evidence, referent path src/fee.ts, and commitAShort
    const weakLineMatch = /<tr class="line-weak-evidence">[\s\S]*?<\/tr>/.exec(level4Html);
    expect(weakLineMatch).not.toBeNull();
    const weakLineHtml = weakLineMatch![0];
    expect(weakLineHtml).toContain("Call `taxFee` to compute tax.");
    expect(weakLineHtml).toContain("src/fee.ts");
    expect(weakLineHtml).toContain(commitAShort);

    // Line 5: has `docs/guide.md` (verified) and `dist/bundle.js` (fog) -> line-fog, shows docs/guide.md @ commitAShort
    const fogLineMatch = /<tr class="line-fog">[\s\S]*?<\/tr>/.exec(level4Html);
    expect(fogLineMatch).not.toBeNull();
    expect(fogLineMatch![0]).toContain("docs/guide.md");
    expect(fogLineMatch![0]).toContain(commitAShort);
  });

  it("adds a documentation section to pr-comment.md with Doc Trust Score before/after comparison and newly introduced fog-returned doc claims when --diff, --pr-comment, and --docs are enabled, and omits doc content without --docs", async () => {
    const feeFile = path.join(tmpDir, "src", "fee.ts");
    const testFile = path.join(tmpDir, "tests", "fee.test.ts");
    const lcovFile = path.join(tmpDir, "coverage", "lcov.info");
    const readmeFile = path.join(tmpDir, "README.md");
    const guideFile = path.join(tmpDir, "docs", "guide.md");

    // Base branch `main`:
    // Commit 1: source code
    await fs.writeFile(
      feeFile,
      [
        "export function calculateFee(amount: number): number {",
        "  return amount * 2;",
        "}",
        "",
        "export function taxFee(amount: number): number {",
        "  return amount * 10;",
        "}",
      ].join("\n"),
      "utf8",
    );
    await git(tmpDir, ["add", "src/fee.ts"]);
    await git(tmpDir, ["commit", "-m", "feat: add fee module"]);

    // Commit 2 on `main`: tests + synchronized docs
    // 3 doc claims on `main`:
    // - `docs/guide.md` (verified: +1.0)
    // - `calculateFee` (weak-evidence: +0.4)
    // - `taxFee` (weak-evidence: +0.4)
    // Base Doc Trust Score = round((1.8 / 3) * 100) = 60, with 0 doc fog-returned
    await fs.writeFile(
      testFile,
      [
        "import { describe, it, expect } from 'vitest';",
        "import { calculateFee, taxFee } from '../src/fee.js';",
        "describe('fee', () => {",
        "  it('verifies fee functions', () => {",
        "    expect(calculateFee(5)).toBe(10);",
        "    expect(taxFee(5)).toBe(50);",
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
        "FN:5,taxFee",
        "FNF:2",
        "FNH:2",
        "FNDA:1,calculateFee",
        "FNDA:1,taxFee",
        "DA:1,1",
        "DA:2,1",
        "DA:5,1",
        "DA:6,1",
        "LF:4",
        "LH:4",
        "end_of_record",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(guideFile, "# Guide\n\nWelcome.\n", "utf8");
    await fs.writeFile(
      readmeFile,
      [
        "# Billing",
        "",
        "See [Guide](docs/guide.md) for overview.",
        "",
        "Call `calculateFee` to double the amount.",
        "",
        "Call `taxFee` to multiply by ten.",
      ].join("\n"),
      "utf8",
    );
    await git(tmpDir, ["add", "."]);
    await git(tmpDir, ["commit", "-m", "test: add tests and synchronized docs on main"]);

    // PR branch: modify calculateFee runtime logic (and update test), without updating README.md
    // Now `calculateFee` claim enters fog-returned (-0.5)
    // PR Doc Trust Score = round(((1.0 - 0.5 + 0.4) / 3) * 100) = 30
    await git(tmpDir, ["checkout", "-b", "feat/pr-doc-returned"]);
    await fs.writeFile(
      feeFile,
      [
        "export function calculateFee(amount: number): number {",
        "  return amount * 3 + 1;",
        "}",
        "",
        "export function taxFee(amount: number): number {",
        "  return amount * 10;",
        "}",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      testFile,
      [
        "import { describe, it, expect } from 'vitest';",
        "import { calculateFee, taxFee } from '../src/fee.js';",
        "describe('fee', () => {",
        "  it('verifies updated fee functions', () => {",
        "    expect(calculateFee(5)).toBe(16);",
        "    expect(taxFee(5)).toBe(50);",
        "  });",
        "});",
      ].join("\n"),
      "utf8",
    );
    await git(tmpDir, ["add", "src/fee.ts", "tests/fee.test.ts"]);
    await git(tmpDir, ["commit", "-m", "feat: update calculateFee formula without updating README"]);
    const prCommitShort = await git(tmpDir, ["rev-parse", "--short", "HEAD"]);

    // 1. Without --docs: pr-comment.md must NOT contain Doc Trust Score or doc claim entries
    await runCli(
      ["--root", tmpDir, "--diff", "main", "--pr-comment", "--fail-on", "none"],
      {
        stdout: () => {},
        stderr: () => {},
      },
    );
    const prCommentNoDocs = await fs.readFile(
      path.join(tmpDir, ".codefog", "pr-comment.md"),
      "utf8",
    );
    expect(prCommentNoDocs).not.toContain("Doc Trust Score");
    expect(prCommentNoDocs).not.toContain("README.md");

    // 2. With --docs: pr-comment.md contains Doc Trust Score before/after (60 -> 30) and lists newly returned `calculateFee` claim
    let jsonOut = "";
    await runCli(
      ["--root", tmpDir, "--docs", "--diff", "main", "--pr-comment", "--json", "--fail-on", "none"],
      {
        stdout: (s) => {
          jsonOut += s;
        },
        stderr: () => {},
      },
    );
    const parsedReport = JSON.parse(jsonOut);
    expect(parsedReport.diff.beforeSummary.docTrustScore).toBe(60);
    expect(parsedReport.summary.docTrustScore).toBe(30);

    const prCommentDocs = await fs.readFile(
      path.join(tmpDir, ".codefog", "pr-comment.md"),
      "utf8",
    );
    expect(prCommentDocs).toContain("Doc Trust Score");
    expect(prCommentDocs).toContain("60 → **30** (-30)");
    expect(prCommentDocs).toContain("README.md:5");
    expect(prCommentDocs).toContain("`calculateFee`");
    expect(prCommentDocs).toContain("src/fee.ts");
    expect(prCommentDocs).toContain(prCommitShort);
    // Unchanged weak-evidence claim `taxFee` must not be listed as a newly returned claim
    expect(prCommentDocs).not.toContain("`taxFee`");
  });
});
