import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { analyzeRepository } from "../src/analyzer.js";
import { analyzeTestAstEvidence } from "../src/ast-evidence.js";
import { formatLevel1Summary, runCli } from "../src/cli.js";
import { renderHtmlFogMap } from "../src/html-report.js";
import * as publicApi from "../src/index.js";
import { renderCodefogSkillMarkdown } from "../src/skill-installer.js";
import { TERMINAL_MAX_COLUMNS, stripAnsi } from "../src/terminal-summary.js";

describe("Ticket 43: code cleanliness, unambiguous contracts, and human/AI reading disambiguation", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefog-t43-"));
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "tests"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "coverage"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("populates uncoveredLines and unhitBranchLines on Finding.evidence and FileSymbolRegion, with line hints in reason", async () => {
    await fs.writeFile(
      path.join(tmpDir, "src", "gate.ts"),
      [
        "export function evaluateGate(score: number, strict: boolean): string {",
        "  if (score < 0) {",
        "    return 'invalid';",
        "  }",
        "  if (strict && score < 80) {",
        "    return 'reject';",
        "  }",
        "  return 'accept';",
        "}",
        "",
        "export function untouchedHelper(x: number): number {",
        "  const doubled = x * 2;",
        "  return doubled + 1;",
        "}",
      ].join("\n"),
      "utf8",
    );

    await fs.writeFile(
      path.join(tmpDir, "tests", "gate.test.ts"),
      [
        "import { describe, it, expect } from 'vitest';",
        "import { evaluateGate } from '../src/gate.js';",
        "describe('gate', () => {",
        "  it('accepts high score', () => {",
        "    expect(evaluateGate(90, false)).toBe('accept');",
        "  });",
        "});",
      ].join("\n"),
      "utf8",
    );

    await fs.writeFile(
      path.join(tmpDir, "coverage", "lcov.info"),
      [
        "TN:",
        "SF:src/gate.ts",
        "FN:1,evaluateGate",
        "FN:11,untouchedHelper",
        "FNF:2",
        "FNH:1",
        "FNDA:1,evaluateGate",
        "FNDA:0,untouchedHelper",
        "DA:1,1",
        "DA:2,1",
        "DA:3,0",
        "DA:5,1",
        "DA:6,0",
        "DA:8,1",
        "DA:11,0",
        "DA:12,0",
        "DA:13,0",
        "BRDA:2,0,0,0",
        "BRDA:2,0,1,1",
        "BRDA:5,1,0,0",
        "BRDA:5,1,1,1",
        "LF:9",
        "LH:4",
        "BRF:4",
        "BRH:2",
        "end_of_record",
      ].join("\n"),
      "utf8",
    );

    const report = await analyzeRepository({ rootDir: tmpDir });
    const gateFinding = report.findings.find((f) => f.title === "evaluateGate");
    const fogFinding = report.findings.find((f) => f.title === "untouchedHelper");

    expect(gateFinding?.state).toBe("weak-evidence");
    expect(gateFinding?.evidence.uncoveredLines).toEqual([3, 6]);
    expect(gateFinding?.evidence.unhitBranchLines).toEqual([2, 5]);
    expect(gateFinding?.reason).toContain("unhit branch lines: 2, 5");

    expect(fogFinding?.state).toBe("fog");
    expect(fogFinding?.evidence.uncoveredLines).toEqual([11, 12, 13]);
    expect(fogFinding?.reason).toContain("uncovered lines: 11, 12, 13");

    const gateRegion = report.files[0]?.regions.find((r) => r.symbol === "evaluateGate");
    expect(gateRegion?.unhitBranchLines).toEqual([2, 5]);
    expect(gateRegion?.uncoveredLines).toEqual([3, 6]);
  });

  it("flags cross-file duplicate bare symbol claims as ambiguous-referent without altering Doc Trust Score, while qualified symbols stay unambiguous", async () => {
    await fs.writeFile(
      path.join(tmpDir, "src", "billing.ts"),
      "export function parsePayload(raw: string): string {\n  return raw.trim();\n}\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(tmpDir, "src", "auth.go"),
      "package auth\n\nfunc parsePayload(raw string) string {\n  return raw\n}\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(tmpDir, "README.md"),
      [
        "# Docs",
        "",
        "Ambiguous bare reference: `parsePayload`.",
        "Disambiguated Go reference: `auth.parsePayload`.",
      ].join("\n"),
      "utf8",
    );

    const report = await analyzeRepository({ rootDir: tmpDir, docs: true });
    const bareClaim = report.docClaims?.find((c) => c.rawText === "parsePayload");
    const qualClaim = report.docClaims?.find((c) => c.rawText === "auth.parsePayload");

    expect(bareClaim?.state).toBe("weak-evidence");
    expect(bareClaim?.ambiguousReferents).toBe(true);
    expect(qualClaim?.state).toBe("weak-evidence");
    expect(qualClaim?.ambiguousReferents).toBeUndefined();

    // Both claims remain weak-evidence (+0.4 each -> Doc Trust 40/100)
    expect(report.summary.docTrustScore).toBe(40);

    const ambFindings = report.findings.filter((f) =>
      f.tags?.includes("ambiguous-referent"),
    );
    expect(ambFindings).toHaveLength(1);
    expect(ambFindings[0]?.subjectType).toBe("doc");
    expect(ambFindings[0]?.state).toBe("weak-evidence");
    expect(ambFindings[0]?.locations?.map((l) => l.file)).toEqual([
      "src/auth.go",
      "src/billing.ts",
    ]);
    expect(ambFindings[0]?.reason).toContain("src/auth.go:3");
    expect(ambFindings[0]?.reason).toContain("src/billing.ts:1");
  });

  it("ignores bare extensions, globs, home paths, @-mentions, and slash commands in --docs while catching genuine missing repo paths", async () => {
    await fs.writeFile(
      path.join(tmpDir, "src", "index.ts"),
      "export function ok(): number {\n  return 1;\n}\n",
      "utf8",
    );
    await fs.writeFile(path.join(tmpDir, ".gitignore"), "dist/\n", "utf8");
    await fs.writeFile(
      path.join(tmpDir, "README.md"),
      [
        "# Conventions",
        "",
        "Supported extensions: `.ts`, `.go`, `.rs`, `.java`, `.md`.",
        "Glob patterns: `*.md`, `*_test.go`, `skills/**/SKILL.md`, `.cursor/rules/*`.",
        "User-local and editor syntax: `~/.cursor/skills/codefog/SKILL.md`, `@.cursor/skills/codefog/SKILL.md`.",
        "Slash skills: `/domain-modeling`, `/grill-with-docs`, `/codefog`.",
        "Real tracked dotfile: `.gitignore`.",
        "Real missing repo path: `docs/missing-spec.md`.",
      ].join("\n"),
      "utf8",
    );

    const report = await analyzeRepository({ rootDir: tmpDir, docs: true });
    const claimTexts = (report.docClaims ?? []).map((c) => c.rawText);

    expect(claimTexts).toEqual([".gitignore", "docs/missing-spec.md"]);
    expect(report.docClaims?.find((c) => c.rawText === ".gitignore")?.state).toBe("verified");
    expect(report.docClaims?.find((c) => c.rawText === "docs/missing-spec.md")?.state).toBe(
      "fog-returned",
    );
  });

  it("surfaces --sarif and --knip external issue counts in HTML Level 1 and TTY color summary without altering non-TTY output or Trust Score", async () => {
    await fs.writeFile(
      path.join(tmpDir, "src", "dead.ts"),
      "export function unusedHelper(a: number): number {\n  return a + 1;\n}\n",
      "utf8",
    );
    const knipPath = path.join(tmpDir, "knip.json");
    await fs.writeFile(
      knipPath,
      JSON.stringify({
        issues: [{ file: "src/dead.ts", exports: [{ name: "unusedHelper", line: 1 }] }],
      }),
      "utf8",
    );
    const sarifPath = path.join(tmpDir, "lint.sarif.json");
    await fs.writeFile(
      sarifPath,
      JSON.stringify({
        version: "2.1.0",
        runs: [
          {
            tool: { driver: { name: "eslint" } },
            results: [
              {
                ruleId: "no-magic-numbers",
                message: { text: "Avoid magic number" },
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: "src/dead.ts" },
                      region: { startLine: 2, endLine: 2 },
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

    let plainOut = "";
    let colorOut = "";
    let jsonOut = "";
    await runCli(["--root", tmpDir, "--knip", knipPath, "--sarif", sarifPath, "--fail-on", "none"], {
      stdout: (s) => (plainOut += s),
      stderr: () => {},
    });
    await runCli(["--root", tmpDir, "--knip", knipPath, "--sarif", sarifPath, "--fail-on", "none"], {
      stdout: (s) => (colorOut += s),
      stderr: () => {},
      color: true,
    });
    await runCli(
      ["--root", tmpDir, "--knip", knipPath, "--sarif", sarifPath, "--json", "--fail-on", "none"],
      {
        stdout: (s) => (jsonOut += s),
        stderr: () => {},
      },
    );

    const parsed = JSON.parse(jsonOut);
    expect(parsed.external.issues).toHaveLength(2);
    expect(plainOut).toBe(formatLevel1Summary(parsed));

    const strippedLines = stripAnsi(colorOut).split("\n");
    expect(strippedLines.some((l) => l.includes("External 2"))).toBe(true);
    for (const line of strippedLines) {
      expect([...line].length).toBeLessThanOrEqual(TERMINAL_MAX_COLUMNS);
    }

    const html = renderHtmlFogMap(parsed);
    expect(html).toContain('data-metric="external-issues"');
    expect(html).toContain('<span class="metric-label">External Issues</span><span class="metric-val">2</span>');
  });

  it("keeps a curated public export surface, aligns ast-evidence with GLOSSARY terms, and reads SKILL.md from a single source", async () => {
    // Public API entry points remain exported
    expect(typeof publicApi.analyzeRepository).toBe("function");
    expect(typeof publicApi.verifyTargetWithMutants).toBe("function");
    expect(typeof publicApi.writeHtmlFogMap).toBe("function");
    expect(typeof publicApi.renderHtmlFogMap).toBe("function");
    expect(typeof publicApi.loadCoverageRecords).toBe("function");
    expect(typeof publicApi.loadMutationReport).toBe("function");
    expect(typeof publicApi.loadStrykerReport).toBe("function");
    expect(typeof publicApi.runCli).toBe("function");

    // Internal lexer/fs helpers are not leaked at the package root
    const exportedKeys = Object.keys(publicApi);
    expect(exportedKeys).not.toContain("stripCommentsAndMaskStrings");
    expect(exportedKeys).not.toContain("findMatchingDelimiter");
    expect(exportedKeys).not.toContain("extractGoFunctionSpans");
    expect(exportedKeys).not.toContain("toPosix");

    // GLOSSARY.md compliance in ast-evidence.ts
    const astSource = await fs.readFile(
      path.join(__dirname, "..", "src", "ast-evidence.ts"),
      "utf8",
    );
    expect(astSource).not.toMatch(/strongAsserted|weakAsserted|STRONG_MATCHERS|WEAK_MATCHERS/);

    await fs.writeFile(
      path.join(tmpDir, "src", "fn.ts"),
      "export function ping(): string { return 'pong'; }\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(tmpDir, "tests", "fn.test.ts"),
      [
        "import { it, expect } from 'vitest';",
        "import { ping } from '../src/fn.js';",
        "it('checks liveness only', () => { expect(ping()).toBeDefined(); });",
      ].join("\n"),
      "utf8",
    );
    const astRes = await analyzeTestAstEvidence(tmpDir);
    const ev = astRes.bySymbol.get("ping");
    expect(ev?.livenessChecksOnly).toBe(1);
    expect(ev?.weakAssertionsOnly).toBe(1);

    // Single source of truth for SKILL.md
    const diskSkill = await fs.readFile(
      path.join(__dirname, "..", "skills", "codefog", "SKILL.md"),
      "utf8",
    );
    expect(renderCodefogSkillMarkdown()).toBe(diskSkill);
    const installerSource = await fs.readFile(
      path.join(__dirname, "..", "src", "skill-installer.ts"),
      "utf8",
    );
    expect(installerSource).not.toContain("Step 1: Run Baseline Evaluation");
  });
});
