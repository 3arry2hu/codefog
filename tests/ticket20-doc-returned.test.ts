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

describe("Ticket 20: Doc Fog Returned via Git timeline & --fail-on doc-returned", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefog-t20-"));
    await git(tmpDir, ["init", "-b", "main"]);
    await git(tmpDir, ["config", "user.name", "Test Bot"]);
    await git(tmpDir, ["config", "user.email", "bot@example.com"]);

    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "coverage"), { recursive: true });

    await fs.writeFile(
      path.join(tmpDir, "coverage", "lcov.info"),
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
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("flags symbol claim as fog-returned when runtime logic changes after doc block, ignores comment/type-only edits, and treats same-commit code+doc edits as synchronized", async () => {
    const feeFile = path.join(tmpDir, "src", "fee.ts");
    const readmeFile = path.join(tmpDir, "README.md");

    // Commit A: write src/fee.ts and README.md referencing calculateFee and taxFee
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
      readmeFile,
      [
        "# Billing",
        "",
        "Call `calculateFee` to compute standard processing fees.",
        "",
        "Call `taxFee` to compute tax on the transaction.",
      ].join("\n"),
      "utf8",
    );

    await git(tmpDir, ["add", "."]);
    await git(tmpDir, ["commit", "-m", "feat: add calculateFee, taxFee and README"]);

    // Same commit: both claims are synchronized -> weak-evidence (never self-proof-fog or fog-returned)
    const reportA = await analyzeRepository({ rootDir: tmpDir, docs: true });
    const claimCalcA = reportA.docClaims?.find((c) => c.target === "calculateFee");
    const claimTaxA = reportA.docClaims?.find((c) => c.target === "taxFee");
    expect(claimCalcA?.state).toBe("weak-evidence");
    expect(claimTaxA?.state).toBe("weak-evidence");
    expect(reportA.summary.docTrustScore).toBe(40);

    // Commit B1: only add comments and change TypeScript types on calculateFee
    await fs.writeFile(
      feeFile,
      [
        "// Fee module comment",
        "export type Cents = number;",
        "export function calculateFee(amount: Cents): Cents {",
        "  // Pure inline comment",
        "  return amount * 0.02;",
        "}",
        "",
        "export function taxFee(amount: Cents): Cents {",
        "  return amount * 0.1;",
        "}",
      ].join("\n"),
      "utf8",
    );
    await git(tmpDir, ["add", "src/fee.ts"]);
    await git(tmpDir, ["commit", "-m", "docs: add comments and type alias Cents"]);

    const reportB1 = await analyzeRepository({ rootDir: tmpDir, docs: true });
    expect(reportB1.docClaims?.find((c) => c.target === "calculateFee")?.state).toBe(
      "weak-evidence",
    );
    expect(reportB1.docClaims?.find((c) => c.target === "taxFee")?.state).toBe("weak-evidence");
    expect(reportB1.summary.docTrustScore).toBe(40);

    // Commit B2: modify runtime logic of both calculateFee and taxFee,
    // while updating only the taxFee paragraph in README in the same commit
    await fs.writeFile(
      feeFile,
      [
        "export type Cents = number;",
        "export function calculateFee(amount: Cents): Cents {",
        "  return Math.round(amount * 0.03 + 50);",
        "}",
        "",
        "export function taxFee(amount: Cents): Cents {",
        "  return Math.round(amount * 0.15);",
        "}",
      ].join("\n"),
      "utf8",
    );

    await fs.writeFile(
      readmeFile,
      [
        "# Billing",
        "",
        "Call `calculateFee` to compute standard processing fees.",
        "",
        "Call `taxFee` to compute the 15% rounded tax on the transaction.",
      ].join("\n"),
      "utf8",
    );

    await git(tmpDir, ["add", "src/fee.ts", "README.md"]);
    await git(tmpDir, ["commit", "-m", "feat: update fee formulas and taxFee docs"]);
    const commitB2Short = await git(tmpDir, ["rev-parse", "--short", "HEAD"]);

    const reportB2 = await analyzeRepository({ rootDir: tmpDir, docs: true });
    const claimCalcB2 = reportB2.docClaims?.find((c) => c.target === "calculateFee");
    const claimTaxB2 = reportB2.docClaims?.find((c) => c.target === "taxFee");

    expect(claimCalcB2?.state).toBe("fog-returned");
    expect(claimCalcB2?.referent?.lastModifiedCommit).toBe(commitB2Short);
    expect(claimCalcB2?.existedAtClaimCommit).toBeUndefined();
    expect(claimTaxB2?.state).toBe("weak-evidence");
    expect(claimTaxB2?.existedAtClaimCommit).toBeUndefined();

    const docFindings = reportB2.findings.filter((f) => f.subjectType === "doc");
    expect(docFindings.length).toBe(1);
    expect(docFindings[0]?.title).toBe("calculateFee");
    expect(docFindings[0]?.state).toBe("fog-returned");
    expect(docFindings[0]?.tags).toEqual(["doc-fog-returned"]);
  });

  it("keeps claim in fog-returned on whitespace-only paragraph edits, and leaves fog-returned on substantive paragraph rewrite", async () => {
    const feeFile = path.join(tmpDir, "src", "fee.ts");
    const readmeFile = path.join(tmpDir, "README.md");

    // Commit A: write calculateFee and README paragraph
    await fs.writeFile(
      feeFile,
      [
        "export function calculateFee(amount: number): number {",
        "  return amount * 0.02;",
        "}",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      readmeFile,
      ["# Billing", "", "Use `calculateFee` to compute fees."].join("\n"),
      "utf8",
    );
    await git(tmpDir, ["add", "."]);
    await git(tmpDir, ["commit", "-m", "feat: initial calculateFee and README"]);

    // Commit B: modify runtime logic of calculateFee
    await fs.writeFile(
      feeFile,
      [
        "export function calculateFee(amount: number): number {",
        "  return amount * 0.05 + 10;",
        "}",
      ].join("\n"),
      "utf8",
    );
    await git(tmpDir, ["add", "src/fee.ts"]);
    await git(tmpDir, ["commit", "-m", "feat: change fee to 5% + 10"]);

    const reportB = await analyzeRepository({ rootDir: tmpDir, docs: true });
    expect(reportB.docClaims?.find((c) => c.target === "calculateFee")?.state).toBe("fog-returned");

    // Commit C1: only add spaces/line breaks inside the paragraph (pure whitespace edit)
    await fs.writeFile(
      readmeFile,
      ["# Billing", "", "Use    `calculateFee`   to\n  compute   fees."].join("\n"),
      "utf8",
    );
    await git(tmpDir, ["add", "README.md"]);
    await git(tmpDir, ["commit", "-m", "docs: whitespace only edit in README"]);

    const reportC1 = await analyzeRepository({ rootDir: tmpDir, docs: true });
    expect(reportC1.docClaims?.find((c) => c.target === "calculateFee")?.state).toBe(
      "fog-returned",
    );
    expect(reportC1.summary.docTrustScore).toBe(0);

    // Commit C2: substantively rewrite the paragraph with non-whitespace changes
    await fs.writeFile(
      readmeFile,
      ["# Billing", "", "Use `calculateFee` to compute the 5% fee plus 10 base charge."].join("\n"),
      "utf8",
    );
    await git(tmpDir, ["add", "README.md"]);
    await git(tmpDir, ["commit", "-m", "docs: substantively update calculateFee description"]);

    const reportC2 = await analyzeRepository({ rootDir: tmpDir, docs: true });
    expect(reportC2.docClaims?.find((c) => c.target === "calculateFee")?.state).toBe(
      "weak-evidence",
    );
    expect(reportC2.summary.docTrustScore).toBe(40);
    expect(reportC2.findings.filter((f) => f.subjectType === "doc")).toEqual([]);
  });

  it("resolves renamed symbol calculateFee -> computeFee via historical commit as fog-returned with '声明最后修改时引用对象存在', and ignores never-existed identifiers", async () => {
    const feeFile = path.join(tmpDir, "src", "fee.ts");
    const readmeFile = path.join(tmpDir, "README.md");

    // Commit A: calculateFee exists in src/fee.ts; README mentions calculateFee and neverExistedSymbol
    await fs.writeFile(
      feeFile,
      [
        "export function calculateFee(amount: number): number {",
        "  return amount * 0.02;",
        "}",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      readmeFile,
      [
        "# Billing",
        "",
        "Call `calculateFee` for fee calculation. Note that `neverExistedSymbol` is just prose.",
      ].join("\n"),
      "utf8",
    );
    await git(tmpDir, ["add", "."]);
    await git(tmpDir, ["commit", "-m", "feat: add calculateFee and README"]);

    // Commit B: rename calculateFee to computeFee in src/fee.ts without updating README
    await fs.writeFile(
      feeFile,
      [
        "export function computeFee(amount: number): number {",
        "  return amount * 0.02;",
        "}",
      ].join("\n"),
      "utf8",
    );
    await git(tmpDir, ["add", "src/fee.ts"]);
    await git(tmpDir, ["commit", "-m", "refactor: rename calculateFee to computeFee"]);
    const commitBShort = await git(tmpDir, ["rev-parse", "--short", "HEAD"]);

    const report = await analyzeRepository({ rootDir: tmpDir, docs: true });
    const claims = report.docClaims ?? [];

    // neverExistedSymbol failed resolution both currently and at claim commit -> not a claim
    expect(claims.find((c) => c.target === "neverExistedSymbol")).toBeUndefined();

    // calculateFee existed at claim commit (Commit A) -> becomes a symbol claim in fog-returned
    const calcClaim = claims.find((c) => c.target === "calculateFee");
    expect(calcClaim).toBeDefined();
    expect(calcClaim?.kind).toBe("symbol");
    expect(calcClaim?.state).toBe("fog-returned");
    expect(calcClaim?.existedAtClaimCommit).toBe(true);
    expect(calcClaim?.referent?.file).toBe("src/fee.ts");
    expect(calcClaim?.referent?.lastModifiedCommit).toBe(commitBShort);

    const docFinding = report.findings.find(
      (f) => f.subjectType === "doc" && f.title === "calculateFee",
    );
    expect(docFinding).toBeDefined();
    expect(docFinding?.state).toBe("fog-returned");
    expect(docFinding?.tags).toEqual(["doc-fog-returned"]);
    expect(docFinding?.reason).toContain("声明最后修改时引用对象存在");
  });

  it("flags command claim as fog-returned when package.json build script definition changes without doc update, and records existedAtClaimCommit on unresolved claims", async () => {
    const pkgFile = path.join(tmpDir, "package.json");
    const readmeFile = path.join(tmpDir, "README.md");
    const legacyDocFile = path.join(tmpDir, "docs", "legacy.md");

    await fs.mkdir(path.join(tmpDir, "docs"), { recursive: true });
    await fs.writeFile(legacyDocFile, "# Legacy\n", "utf8");

    // Commit A: package.json defines build, test, and bin mycli; src/cli.ts has verify and legacy-sync subcommands;
    // README references npm run build, npm test, mycli legacy-sync, mycli never-sub, docs/legacy.md, and docs/never.md
    await fs.writeFile(
      pkgFile,
      JSON.stringify(
        {
          name: "demo-pkg",
          bin: {
            mycli: "src/cli.ts",
          },
          scripts: {
            build: "tsc -p tsconfig.json",
            test: "vitest run",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await fs.writeFile(
      path.join(tmpDir, "src", "cli.ts"),
      [
        "export function runCli(argv: string[]): number {",
        "  if (argv[0] === 'verify' || argv[0] === 'legacy-sync') return 0;",
        "  return 1;",
        "}",
      ].join("\n"),
      "utf8",
    );

    await fs.writeFile(
      readmeFile,
      [
        "# Scripts",
        "",
        "Run `npm run build` to compile the project.",
        "",
        "Run `npm test` to execute unit tests.",
        "",
        "Run `mycli legacy-sync` or `mycli never-sub`.",
        "",
        "See `docs/legacy.md` and `docs/never.md`.",
      ].join("\n"),
      "utf8",
    );

    await git(tmpDir, ["add", "."]);
    await git(tmpDir, ["commit", "-m", "feat: add package.json scripts, cli, and README"]);

    // Commit B: change build script definition in package.json, remove legacy-sync subcommand from src/cli.ts, and delete docs/legacy.md without updating README
    await fs.writeFile(
      pkgFile,
      JSON.stringify(
        {
          name: "demo-pkg",
          bin: {
            mycli: "src/cli.ts",
          },
          scripts: {
            build: "tsup src/fee.ts --format esm",
            test: "vitest run",
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(
      path.join(tmpDir, "src", "cli.ts"),
      [
        "export function runCli(argv: string[]): number {",
        "  if (argv[0] === 'verify') return 0;",
        "  return 1;",
        "}",
      ].join("\n"),
      "utf8",
    );
    await fs.rm(legacyDocFile);
    await git(tmpDir, ["add", "-A"]);
    await git(tmpDir, ["commit", "-m", "build: switch build script to tsup and remove legacy doc/subcommand"]);
    const commitBShort = await git(tmpDir, ["rev-parse", "--short", "HEAD"]);

    const report = await analyzeRepository({ rootDir: tmpDir, docs: true });
    const claims = report.docClaims ?? [];

    const buildClaim = claims.find((c) => c.rawText === "npm run build");
    const testClaim = claims.find((c) => c.rawText === "npm test");
    const legacySubClaim = claims.find((c) => c.rawText === "mycli legacy-sync");
    const neverSubClaim = claims.find((c) => c.rawText === "mycli never-sub");
    const legacyPathClaim = claims.find((c) => c.rawText === "docs/legacy.md");
    const neverPathClaim = claims.find((c) => c.rawText === "docs/never.md");

    // build script definition changed after README block -> fog-returned, but resolution succeeded so existedAtClaimCommit is not set
    expect(buildClaim?.state).toBe("fog-returned");
    expect(buildClaim?.referent?.lastModifiedCommit).toBe(commitBShort);
    expect(buildClaim?.existedAtClaimCommit).toBeUndefined();

    // test script definition unchanged -> stays weak-evidence, existedAtClaimCommit is not set
    expect(testClaim?.state).toBe("weak-evidence");
    expect(testClaim?.existedAtClaimCommit).toBeUndefined();

    // Unresolved bin subcommand claims compute existedAtClaimCommit from git history
    expect(legacySubClaim?.state).toBe("fog-returned");
    expect(legacySubClaim?.existedAtClaimCommit).toBe(true);
    expect(neverSubClaim?.state).toBe("fog-returned");
    expect(neverSubClaim?.existedAtClaimCommit).toBe(false);

    // Both unresolved path claims are fog-returned, but existedAtClaimCommit distinguishes deleted vs never-existed
    expect(legacyPathClaim?.state).toBe("fog-returned");
    expect(legacyPathClaim?.existedAtClaimCommit).toBe(true);
    expect(neverPathClaim?.state).toBe("fog-returned");
    expect(neverPathClaim?.existedAtClaimCommit).toBe(false);

    const legacyFinding = report.findings.find(
      (f) => f.subjectType === "doc" && f.title === "docs/legacy.md",
    );
    const neverFinding = report.findings.find(
      (f) => f.subjectType === "doc" && f.title === "docs/never.md",
    );
    expect(legacyFinding?.reason).toContain("声明最后修改时引用对象存在");
    expect(neverFinding?.reason).toContain("声明最后修改时引用对象不存在");
  });

  it("enforces --fail-on doc-returned (1 when doc fog-returned exists, 0 when clear) and keeps --fail-on returned unaffected by doc claims", async () => {
    const feeFile = path.join(tmpDir, "src", "fee.ts");
    const readmeFile = path.join(tmpDir, "README.md");

    // Commit A: synchronized code and README
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
      readmeFile,
      ["# Billing", "", "Use `calculateFee` for fees."].join("\n"),
      "utf8",
    );
    await git(tmpDir, ["add", "."]);
    await git(tmpDir, ["commit", "-m", "feat: initial synchronized code and docs"]);

    // 1. No doc fog-returned -> --fail-on doc-returned returns 0
    const exitClear = await runCli(
      ["--root", tmpDir, "--docs", "--fail-on", "doc-returned"],
      {
        stdout: () => {},
        stderr: () => {},
      },
    );
    expect(exitClear).toBe(0);

    // Commit B: modify calculateFee runtime logic without updating README -> doc claim enters fog-returned
    // (Note: no test files exist in this fixture so code locByState['fog-returned'] is 0)
    await fs.writeFile(
      feeFile,
      [
        "export function calculateFee(amount: number): number {",
        "  return amount * 0.05;",
        "}",
        "",
        "export function taxFee(amount: number): number {",
        "  return amount * 0.1;",
        "}",
      ].join("\n"),
      "utf8",
    );
    await git(tmpDir, ["add", "src/fee.ts"]);
    await git(tmpDir, ["commit", "-m", "feat: update calculateFee rate"]);

    // 2. Doc fog-returned > 0 -> --fail-on doc-returned returns 1
    const exitDocReturned = await runCli(
      ["--root", tmpDir, "--docs", "--fail-on", "doc-returned"],
      {
        stdout: () => {},
        stderr: () => {},
      },
    );
    expect(exitDocReturned).toBe(1);

    // 3. Even without explicit --docs flag, --fail-on doc-returned enables doc analysis and returns 1
    const exitImplicitDocs = await runCli(
      ["--root", tmpDir, "--fail-on", "doc-returned"],
      {
        stdout: () => {},
        stderr: () => {},
      },
    );
    expect(exitImplicitDocs).toBe(1);

    // 4. --fail-on returned only checks code fog-returned (0 here), unaffected by doc fog-returned -> returns 0
    const exitCodeReturned = await runCli(
      ["--root", tmpDir, "--docs", "--fail-on", "returned"],
      {
        stdout: () => {},
        stderr: () => {},
      },
    );
    expect(exitCodeReturned).toBe(0);
  });
});
