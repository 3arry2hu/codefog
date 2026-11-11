import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { analyzeRepository } from "../src/analyzer.js";
import { runCli } from "../src/cli.js";

describe("Ticket 23: AI instruction files command verification & instruction-conflict", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefog-t23-"));
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "coverage"), { recursive: true });

    await fs.writeFile(
      path.join(tmpDir, "package.json"),
      JSON.stringify(
        {
          name: "demo-repo",
          scripts: {
            test: "vitest run",
            build: "tsc -p tsconfig.json",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await fs.writeFile(
      path.join(tmpDir, "src", "index.ts"),
      [
        "export function add(a: number, b: number): number {",
        "  return a + b;",
        "}",
      ].join("\n"),
      "utf8",
    );

    await fs.writeFile(
      path.join(tmpDir, "coverage", "lcov.info"),
      [
        "TN:",
        "SF:src/index.ts",
        "FN:1,add",
        "FNF:1",
        "FNH:1",
        "FNDA:1,add",
        "DA:1,1",
        "DA:2,1",
        "LF:2",
        "LH:2",
        "end_of_record",
      ].join("\n"),
      "utf8",
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("emits an instruction-conflict Finding with both files and line numbers when AGENTS.md has `npm test` and CLAUDE.md has `npx vitest run`, and emits no conflict when both use `npm test`", async () => {
    await fs.writeFile(
      path.join(tmpDir, "AGENTS.md"),
      [
        "# Agent Instructions",
        "",
        "Run `npm test` before committing.",
      ].join("\n"),
      "utf8",
    );

    await fs.writeFile(
      path.join(tmpDir, "CLAUDE.md"),
      [
        "# Claude Guide",
        "",
        "## Verification",
        "",
        "Always execute `npx vitest run` to verify changes.",
      ].join("\n"),
      "utf8",
    );

    const conflictReport = await analyzeRepository({ rootDir: tmpDir, docs: true });
    const claims = conflictReport.docClaims ?? [];

    const agentsClaim = claims.find((c) => c.file === "AGENTS.md" && c.referentText === "npm test");
    const claudeClaim = claims.find(
      (c) => c.file === "CLAUDE.md" && c.referentText === "npx vitest run",
    );

    expect(agentsClaim).toBeDefined();
    expect(agentsClaim?.state).toBe("weak-evidence");
    expect(agentsClaim?.startLine).toBe(3);

    expect(claudeClaim).toBeDefined();
    expect(claudeClaim?.state).toBe("weak-evidence");
    expect(claudeClaim?.startLine).toBe(5);

    const conflictFindings = conflictReport.findings.filter((f) =>
      f.tags?.includes("instruction-conflict"),
    );
    expect(conflictFindings).toHaveLength(1);

    const conflict = conflictFindings[0]!;
    expect(conflict.subjectType).toBe("doc");
    expect(conflict.state).toBe("weak-evidence");
    expect(conflict.reason).toContain("AGENTS.md:3");
    expect(conflict.reason).toContain("CLAUDE.md:5");
    expect(conflict.locations).toEqual([
      {
        file: "AGENTS.md",
        symbol: "npm test",
        startLine: 3,
        endLine: 3,
        command: "npm test",
      },
      {
        file: "CLAUDE.md",
        symbol: "npx vitest run",
        startLine: 5,
        endLine: 5,
        command: "npx vitest run",
      },
    ]);

    // Now update CLAUDE.md to also use `npm test` -> no conflict
    await fs.writeFile(
      path.join(tmpDir, "CLAUDE.md"),
      [
        "# Claude Guide",
        "",
        "Always execute `npm test` to verify changes.",
      ].join("\n"),
      "utf8",
    );

    const alignedReport = await analyzeRepository({ rootDir: tmpDir, docs: true });
    const alignedConflicts = alignedReport.findings.filter((f) =>
      f.tags?.includes("instruction-conflict"),
    );
    expect(alignedConflicts).toHaveLength(0);
  });

  it("marks `npm run lint` in AGENTS.md as fog-returned when package.json has no lint script, preserves fog-returned on failed side of a conflict, and passes `--fail-on doc-returned` when only instruction-conflict exists", async () => {
    // 1. Only instruction-conflict (no doc fog-returned): --fail-on doc-returned returns 0
    await fs.writeFile(
      path.join(tmpDir, "AGENTS.md"),
      "# Agents\n\nRun `npm test`.\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(tmpDir, "CLAUDE.md"),
      "# Claude\n\nRun `npx vitest run`.\n",
      "utf8",
    );

    const exitConflictOnly = await runCli(
      ["--root", tmpDir, "--docs", "--fail-on", "doc-returned"],
      {
        stdout: () => {},
        stderr: () => {},
      },
    );
    expect(exitConflictOnly).toBe(0);

    // 2. Add `npm run lint` to AGENTS.md while package.json has no `lint` script,
    // and `npx eslint .` to CLAUDE.md:
    // AGENTS.md `npm run lint` is fog-returned, CLAUDE.md `npx eslint .` is weak-evidence,
    // an instruction-conflict for lint is emitted, and --fail-on doc-returned returns 1.
    await fs.writeFile(
      path.join(tmpDir, "AGENTS.md"),
      "# Agents\n\nRun `npm run lint`.\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(tmpDir, "CLAUDE.md"),
      "# Claude\n\nRun `npx eslint .`.\n",
      "utf8",
    );

    const report = await analyzeRepository({ rootDir: tmpDir, docs: true });
    const claims = report.docClaims ?? [];
    const agentsLint = claims.find(
      (c) => c.file === "AGENTS.md" && c.referentText === "npm run lint",
    );
    const claudeLint = claims.find(
      (c) => c.file === "CLAUDE.md" && c.referentText === "npx eslint .",
    );

    expect(agentsLint?.state).toBe("fog-returned");
    expect(claudeLint?.state).toBe("weak-evidence");

    const conflictFindings = report.findings.filter((f) =>
      f.tags?.includes("instruction-conflict"),
    );
    expect(conflictFindings).toHaveLength(1);
    expect(conflictFindings[0]?.reason).toContain("AGENTS.md:3");
    expect(conflictFindings[0]?.reason).toContain("CLAUDE.md:3");

    const exitWithDocReturned = await runCli(
      ["--root", tmpDir, "--docs", "--fail-on", "doc-returned"],
      {
        stdout: () => {},
        stderr: () => {},
      },
    );
    expect(exitWithDocReturned).toBe(1);
  });

  it("maps intents strictly from command text (ignoring section headings), checks all instruction file locations (.cursor/rules/*, .github/copilot-instructions.md, skills/**/SKILL.md), and compares third-party commands without existence failures", async () => {
    await fs.writeFile(
      path.join(tmpDir, "package.json"),
      JSON.stringify(
        {
          name: "polyglot-repo",
          scripts: {
            build: "tsc",
            seed: "node scripts/seed.js",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await fs.mkdir(path.join(tmpDir, ".cursor", "rules"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, ".github"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "skills", "verify"), { recursive: true });

    // .cursor/rules/go.mdc puts `go test ./...` under a misleading "## Build" heading
    // and an unknown-intent command `npm run seed` under "## Test"
    await fs.writeFile(
      path.join(tmpDir, ".cursor", "rules", "go.mdc"),
      [
        "# Cursor Rule",
        "",
        "## Build",
        "Run `go test ./...` before pushing.",
        "",
        "## Test",
        "Populate fixtures with `npm run seed` or missing `npm run migrate`.",
      ].join("\n"),
      "utf8",
    );

    // .github/copilot-instructions.md has `mvn test` and `npx tsc --noEmit`
    await fs.writeFile(
      path.join(tmpDir, ".github", "copilot-instructions.md"),
      [
        "# Copilot Instructions",
        "",
        "Use `mvn test` for verification and `npx tsc --noEmit` for compilation.",
      ].join("\n"),
      "utf8",
    );

    // skills/verify/SKILL.md has `npm run build`
    await fs.writeFile(
      path.join(tmpDir, "skills", "verify", "SKILL.md"),
      [
        "# Verify Skill",
        "",
        "Compile the project with `npm run build`.",
      ].join("\n"),
      "utf8",
    );

    // README.md is not an instruction file; its `pnpm install` must not trigger instruction-conflict
    await fs.writeFile(
      path.join(tmpDir, "README.md"),
      "# Readme\n\nInstall with `pnpm install`.\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(tmpDir, "AGENTS.md"),
      "# Agents\n\nInstall with `npm install`.\n",
      "utf8",
    );

    const report = await analyzeRepository({ rootDir: tmpDir, docs: true });
    const claims = report.docClaims ?? [];

    // Third-party commands `go test ./...`, `mvn test`, `npx tsc --noEmit` are weak-evidence (not fog-returned)
    const goTestClaim = claims.find((c) => c.referentText === "go test ./...");
    const mvnTestClaim = claims.find((c) => c.referentText === "mvn test");
    const tscBuildClaim = claims.find((c) => c.referentText === "npx tsc --noEmit");
    expect(goTestClaim?.state).toBe("weak-evidence");
    expect(goTestClaim?.commandIntent).toBe("test");
    expect(mvnTestClaim?.state).toBe("weak-evidence");
    expect(mvnTestClaim?.commandIntent).toBe("test");
    expect(tscBuildClaim?.state).toBe("weak-evidence");
    expect(tscBuildClaim?.commandIntent).toBe("build");

    // Unrecognized-intent commands (`npm run seed`, `npm run migrate`) only do existence check, ignoring "## Test" heading
    const seedClaim = claims.find((c) => c.referentText === "npm run seed");
    const migrateClaim = claims.find((c) => c.referentText === "npm run migrate");
    expect(seedClaim?.commandIntent).toBeUndefined();
    expect(seedClaim?.state).toBe("weak-evidence");
    expect(migrateClaim?.commandIntent).toBeUndefined();
    expect(migrateClaim?.state).toBe("fog-returned");

    // Conflicts:
    // 1. `test` conflict between .cursor/rules/go.mdc:4 (`go test ./...`) and .github/copilot-instructions.md:3 (`mvn test`)
    // 2. `build` conflict between .github/copilot-instructions.md:3 (`cargo build`) and skills/verify/SKILL.md:3 (`npm run build`)
    // No `install` conflict because README.md is not an instruction file
    const conflictFindings = report.findings.filter((f) =>
      f.tags?.includes("instruction-conflict"),
    );
    expect(conflictFindings).toHaveLength(2);

    const testConflict = conflictFindings.find((f) => f.title.includes("(test)"));
    const buildConflict = conflictFindings.find((f) => f.title.includes("(build)"));

    expect(testConflict).toBeDefined();
    expect(testConflict?.reason).toContain(".cursor/rules/go.mdc:4");
    expect(testConflict?.reason).toContain(".github/copilot-instructions.md:3");

    expect(buildConflict).toBeDefined();
    expect(buildConflict?.reason).toContain(".github/copilot-instructions.md:3");
    expect(buildConflict?.reason).toContain("skills/verify/SKILL.md:3");
  });
});
