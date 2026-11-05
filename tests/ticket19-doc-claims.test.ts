import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { analyzeRepository } from "../src/analyzer.js";
import { runCli } from "../src/cli.js";

describe("Ticket 19: Doc Claims extraction, deterministic resolution & Doc Trust Score (--docs)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefog-t19-"));
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "docs"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "coverage"), { recursive: true });

    await fs.writeFile(
      path.join(tmpDir, "src", "analyzer.ts"),
      [
        "export function analyzeRepository(rootDir: string): string {",
        "  return rootDir;",
        "}",
      ].join("\n"),
      "utf8",
    );

    await fs.writeFile(
      path.join(tmpDir, "coverage", "lcov.info"),
      [
        "TN:",
        "SF:src/analyzer.ts",
        "FN:1,analyzeRepository",
        "FNF:1",
        "FNH:1",
        "FNDA:1,analyzeRepository",
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

  it("resolves existing docs/guide.md and #quick-start anchor as verified, and missing docs/missing.md as fog-returned", async () => {
    await fs.writeFile(
      path.join(tmpDir, "docs", "guide.md"),
      "# Guide\n\nWelcome to the guide.\n",
      "utf8",
    );

    await fs.writeFile(
      path.join(tmpDir, "README.md"),
      [
        "# Project",
        "",
        "## Quick Start",
        "",
        "Read [the guide](docs/guide.md) or jump to [Quick Start](#quick-start).",
        "Avoid the removed `docs/missing.md` file.",
      ].join("\n"),
      "utf8",
    );

    const report = await analyzeRepository({ rootDir: tmpDir, docs: true });

    expect(report.docClaims).toBeDefined();
    const guideClaim = report.docClaims?.find((c) => c.referentText === "docs/guide.md");
    const anchorClaim = report.docClaims?.find((c) => c.referentText === "#quick-start");
    const missingClaim = report.docClaims?.find((c) => c.referentText === "docs/missing.md");

    expect(guideClaim?.state).toBe("verified");
    expect(guideClaim?.referent?.file).toBe("docs/guide.md");

    expect(anchorClaim?.state).toBe("verified");
    expect(anchorClaim?.referent?.file).toBe("README.md");
    expect(anchorClaim?.referent?.anchor).toBe("quick-start");

    expect(missingClaim?.state).toBe("fog-returned");

    // 2 verified (+2.0) and 1 fog-returned (-0.5) out of 3 claims -> round((1.5 / 3) * 100) = 50
    expect(report.summary.docTrustScore).toBe(50);
    expect(report.docTrustScore).toBe(50);
  });

  it("extracts symbol claims across languages as weak-evidence, binds all candidates for duplicate names, and ignores true, --json, CF-xxxx, and unknown identifiers", async () => {
    await fs.writeFile(
      path.join(tmpDir, "src", "billing.ts"),
      [
        "export class FeeCalculator {",
        "  compute(amount: number): number {",
        "    return amount * 0.02;",
        "  }",
        "}",
        "export function parseToken(raw: string): string {",
        "  return raw.trim();",
        "}",
      ].join("\n"),
      "utf8",
    );

    await fs.writeFile(
      path.join(tmpDir, "src", "auth.go"),
      [
        "package auth",
        "",
        "func parseToken(raw string) string {",
        "  return raw",
        "}",
      ].join("\n"),
      "utf8",
    );

    await fs.writeFile(
      path.join(tmpDir, "src", "validator.rs"),
      [
        "pub struct TokenValidator;",
        "impl TokenValidator {",
        "  pub fn validate(raw: &str) -> bool {",
        "    !raw.is_empty()",
        "  }",
        "}",
      ].join("\n"),
      "utf8",
    );

    await fs.writeFile(
      path.join(tmpDir, "src", "OrderService.java"),
      [
        "package com.acme;",
        "public class OrderService {",
        "  public int submitOrder(int id) {",
        "    return id;",
        "  }",
        "}",
      ].join("\n"),
      "utf8",
    );

    await fs.writeFile(
      path.join(tmpDir, "README.md"),
      [
        "# API",
        "",
        "Call `analyzeRepository` or `FeeCalculator` or `compute`.",
        "Both modules define `parseToken`, and Go defines `auth.parseToken`.",
        "Rust defines `TokenValidator::validate` and Java defines `OrderService.submitOrder` (or instance call `svc.submitOrder`).",
        "Flags like `--json`, literals like `true`, findings like `CF-xxxx`, and prose `unknownIdentifier` are not claims.",
      ].join("\n"),
      "utf8",
    );

    const report = await analyzeRepository({ rootDir: tmpDir, docs: true });
    const claims = report.docClaims ?? [];

    expect(claims.map((c) => c.rawText)).toEqual([
      "analyzeRepository",
      "FeeCalculator",
      "compute",
      "parseToken",
      "auth.parseToken",
      "TokenValidator::validate",
      "OrderService.submitOrder",
      "svc.submitOrder",
    ]);

    for (const c of claims) {
      expect(c.kind).toBe("symbol");
      expect(c.state).toBe("weak-evidence");
    }

    const goQualClaim = claims.find((c) => c.rawText === "auth.parseToken");
    expect(goQualClaim?.referents.map((r) => r.file)).toEqual(["src/auth.go"]);

    const rustQualClaim = claims.find((c) => c.rawText === "TokenValidator::validate");
    expect(rustQualClaim?.referents.map((r) => r.file)).toEqual(["src/validator.rs"]);

    const javaQualClaim = claims.find((c) => c.rawText === "OrderService.submitOrder");
    expect(javaQualClaim?.referents.map((r) => r.file)).toEqual(["src/OrderService.java"]);

    const bareFallbackClaim = claims.find((c) => c.rawText === "svc.submitOrder");
    expect(bareFallbackClaim?.referents.map((r) => r.file)).toEqual(["src/OrderService.java"]);

    const parseTokenClaim = claims.find((c) => c.referentText === "parseToken");
    expect(parseTokenClaim?.referents.map((r) => r.file).sort()).toEqual([
      "src/auth.go",
      "src/billing.ts",
    ]);

    expect(claims.find((c) => c.rawText === "true")).toBeUndefined();
    expect(claims.find((c) => c.rawText === "--json")).toBeUndefined();
    expect(claims.find((c) => c.rawText === "CF-xxxx")).toBeUndefined();
    expect(claims.find((c) => c.rawText === "unknownIdentifier")).toBeUndefined();
  });

  it("classifies .codefog/report.html, known output dirs, and .gitignore paths as fog rather than fog-returned", async () => {
    await fs.writeFile(
      path.join(tmpDir, ".gitignore"),
      ["# Build and generated artifacts", "reports/", "*.gen.ts", "/artifacts/output.json"].join("\n"),
      "utf8",
    );

    await fs.writeFile(
      path.join(tmpDir, "README.md"),
      [
        "# Artifacts",
        "",
        "Open `.codefog/report.html` or `dist/bundle.js` or `target/release/app` or `coverage/summary.json`.",
        "Also check gitignored `reports/mutation.json`, `src/schema.gen.ts`, and `artifacts/output.json`.",
      ].join("\n"),
      "utf8",
    );

    const report = await analyzeRepository({ rootDir: tmpDir, docs: true });
    const claims = report.docClaims ?? [];

    expect(claims.length).toBe(7);
    for (const c of claims) {
      expect(c.state).toBe("fog");
    }
    expect(report.summary.docClaimsByState?.["fog-returned"]).toBe(0);
    expect(report.summary.docClaimsByState?.fog).toBe(7);
    expect(report.findings.filter((f) => f.subjectType === "doc")).toEqual([]);
  });

  it("resolves package manager scripts, node/tsx file commands, and repo bin subcommands to weak-evidence when valid and fog-returned when missing", async () => {
    await fs.writeFile(
      path.join(tmpDir, "package.json"),
      JSON.stringify(
        {
          name: "@acme/my-cli",
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
        "export function run(argv: string[]): number {",
        "  if (argv[0] === 'verify' || argv[0] === 'sync') return 0;",
        "  return 1;",
        "}",
      ].join("\n"),
      "utf8",
    );

    await fs.writeFile(
      path.join(tmpDir, "README.md"),
      [
        "# Commands",
        "",
        "Run `npm run build` and `npm test` to verify the project.",
        "Do not run removed `pnpm run deploy`.",
        "Execute `tsx src/cli.ts` or missing `node scripts/nonexistent.js`.",
        "CLI subcommands: `mycli verify src/analyzer.ts --strict` vs obsolete `mycli publish-all`.",
      ].join("\n"),
      "utf8",
    );

    const report = await analyzeRepository({ rootDir: tmpDir, docs: true });
    const claims = report.docClaims ?? [];

    const byRaw = new Map(claims.map((c) => [c.rawText, c]));
    expect(byRaw.get("npm run build")?.state).toBe("weak-evidence");
    expect(byRaw.get("npm run build")?.referent?.script).toBe("build");
    expect(byRaw.get("npm run build")?.referent?.scriptDefinition).toBe("tsc -p tsconfig.json");

    expect(byRaw.get("npm test")?.state).toBe("weak-evidence");
    expect(byRaw.get("npm test")?.referent?.script).toBe("test");

    expect(byRaw.get("pnpm run deploy")?.state).toBe("fog-returned");

    expect(byRaw.get("tsx src/cli.ts")?.state).toBe("weak-evidence");
    expect(byRaw.get("tsx src/cli.ts")?.referent?.file).toBe("src/cli.ts");

    expect(byRaw.get("node scripts/nonexistent.js")?.state).toBe("fog-returned");

    expect(byRaw.get("mycli verify src/analyzer.ts --strict")?.state).toBe("weak-evidence");
    expect(byRaw.get("mycli publish-all")?.state).toBe("fog-returned");
  });

  it("exempts blocks after <!-- codefog-ignore-next --> and files with <!-- codefog-ignore-file -->, keeping Doc Trust Score and code Trust Score exact", async () => {
    await fs.mkdir(path.join(tmpDir, "docs", "adr"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, ".cursor", "rules"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "skills", "demo"), { recursive: true });

    await fs.writeFile(
      path.join(tmpDir, "docs", "guide.md"),
      "# Guide\n\nValid guide.\n",
      "utf8",
    );

    await fs.writeFile(
      path.join(tmpDir, "docs", "adr", "0001-ignored.md"),
      [
        "<!-- codefog-ignore-file -->",
        "# ADR 0001",
        "",
        "Intentionally mentions `docs/deleted-legacy.md` and `npm run deleted-script`.",
      ].join("\n"),
      "utf8",
    );

    await fs.writeFile(
      path.join(tmpDir, "AGENTS.md"),
      "Always check `docs/guide.md`.\n",
      "utf8",
    );

    await fs.writeFile(
      path.join(tmpDir, ".cursor", "rules", "check.md"),
      "Call `analyzeRepository`.\n",
      "utf8",
    );

    await fs.writeFile(
      path.join(tmpDir, "skills", "demo", "SKILL.md"),
      [
        "# Demo Skill",
        "",
        "<!-- codefog-ignore-next -->",
        "Bad example: `docs/intentionally-missing.md` and `npm run bad-script`.",
        "",
        "Good example: [Guide](../../docs/guide.md).",
      ].join("\n"),
      "utf8",
    );

    const baselineReport = await analyzeRepository({ rootDir: tmpDir });
    const docsReport = await analyzeRepository({ rootDir: tmpDir, docs: true });

    // Code Trust Score must be identical with or without --docs
    expect(docsReport.summary.trustScore).toBe(baselineReport.summary.trustScore);

    // Exempted claims must not appear in docClaims or findings
    const claimReferentTexts = (docsReport.docClaims ?? []).map((c) => c.referentText);
    expect(claimReferentTexts).not.toContain("docs/deleted-legacy.md");
    expect(claimReferentTexts).not.toContain("npm run deleted-script");
    expect(claimReferentTexts).not.toContain("docs/intentionally-missing.md");
    expect(claimReferentTexts).not.toContain("npm run bad-script");

    // Non-exempted claims:
    // 1. AGENTS.md: `docs/guide.md` -> verified (+1.0)
    // 2. .cursor/rules/check.md: `analyzeRepository` -> weak-evidence (+0.4)
    // 3. skills/demo/SKILL.md: `../../docs/guide.md` -> verified (+1.0)
    // Total = 3 claims, weighted = 2.4 -> round((2.4 / 3) * 100) = 80
    expect(docsReport.docClaims?.length).toBe(3);
    expect(docsReport.summary.docTrustScore).toBe(80);
    expect(docsReport.docTrustScore).toBe(80);
  });

  it("supports --docs and --check-external-links via runCli, outputs both Trust Scores in terminal and JSON, and keeps JSON free of doc fields without --docs", async () => {
    await fs.writeFile(
      path.join(tmpDir, "docs", "guide.md"),
      "# Guide\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(tmpDir, "README.md"),
      [
        "# Project",
        "",
        "See `docs/guide.md` and [Broken External](http://127.0.0.1:1/unreachable-doc-link).",
      ].join("\n"),
      "utf8",
    );

    // 1. Without --docs: --json has no doc fields at all
    let jsonNoDocs = "";
    const codeNoDocs = await runCli(["--root", tmpDir, "--json", "--fail-on", "none"], {
      stdout: (s) => {
        jsonNoDocs += s;
      },
      stderr: () => {},
    });
    expect(codeNoDocs).toBe(0);
    const parsedNoDocs = JSON.parse(jsonNoDocs);
    expect("docTrustScore" in parsedNoDocs).toBe(false);
    expect("docClaims" in parsedNoDocs).toBe(false);
    expect("docTrustScore" in parsedNoDocs.summary).toBe(false);
    expect("docClaimsByState" in parsedNoDocs.summary).toBe(false);
    expect("totalDocClaims" in parsedNoDocs.summary).toBe(false);

    // 2. With --docs (without --check-external-links): external link is fog
    let jsonDocs = "";
    const codeDocs = await runCli(["--root", tmpDir, "--docs", "--json", "--fail-on", "none"], {
      stdout: (s) => {
        jsonDocs += s;
      },
      stderr: () => {},
    });
    expect(codeDocs).toBe(0);
    const parsedDocs = JSON.parse(jsonDocs);
    // 1 verified (docs/guide.md: +1.0) + 1 fog (external link: 0.0) -> round((1.0 / 2) * 100) = 50
    expect(parsedDocs.summary.docTrustScore).toBe(50);
    expect(parsedDocs.docTrustScore).toBe(50);
    const extClaimUnchecked = parsedDocs.docClaims.find((c: { referentText: string }) =>
      c.referentText.startsWith("http://127.0.0.1:1/"),
    );
    expect(extClaimUnchecked?.state).toBe("fog");

    // 3. With --docs and --check-external-links: unreachable external link becomes weak-evidence
    let jsonExtChecked = "";
    await runCli(
      ["--root", tmpDir, "--docs", "--check-external-links", "--json", "--fail-on", "none"],
      {
        stdout: (s) => {
          jsonExtChecked += s;
        },
        stderr: () => {},
      },
    );
    const parsedExtChecked = JSON.parse(jsonExtChecked);
    const extClaimChecked = parsedExtChecked.docClaims.find((c: { referentText: string }) =>
      c.referentText.startsWith("http://127.0.0.1:1/"),
    );
    expect(extClaimChecked?.state).toBe("weak-evidence");
    // 1 verified (+1.0) + 1 weak-evidence (+0.4) -> round((1.4 / 2) * 100) = 70
    expect(parsedExtChecked.summary.docTrustScore).toBe(70);

    // 4. Terminal human summary with --docs outputs both Trust Score and Doc Trust Score
    let humanOut = "";
    await runCli(["--root", tmpDir, "--docs", "--fail-on", "none"], {
      stdout: (s) => {
        humanOut += s;
      },
      stderr: () => {},
    });
    expect(humanOut).toContain(`Trust Score: ${parsedNoDocs.summary.trustScore}/100`);
    expect(humanOut).toContain("Doc Trust Score: 50/100");
  });

  it("retains block kind and line ranges (paragraph, list-item, table-row) on extracted claims", async () => {
    await fs.writeFile(
      path.join(tmpDir, "docs", "guide.md"),
      "# Guide\n",
      "utf8",
    );

    await fs.writeFile(
      path.join(tmpDir, "README.md"),
      [
        "# Title",
        "",
        "Paragraph line 1",
        "referencing `analyzeRepository` on line 4.",
        "",
        "- List item line 6",
        "  referencing `docs/guide.md` on line 7.",
        "",
        "| Name | Target |",
        "| :--- | :--- |",
        "| Row | `docs/missing.md` |",
      ].join("\n"),
      "utf8",
    );

    const report = await analyzeRepository({ rootDir: tmpDir, docs: true });
    const claims = report.docClaims ?? [];

    const paraClaim = claims.find((c) => c.referentText === "analyzeRepository");
    expect(paraClaim?.blockKind).toBe("paragraph");
    expect(paraClaim?.startLine).toBe(4);
    expect(paraClaim?.blockStartLine).toBe(3);
    expect(paraClaim?.blockEndLine).toBe(4);

    const listClaim = claims.find((c) => c.referentText === "docs/guide.md");
    expect(listClaim?.blockKind).toBe("list-item");
    expect(listClaim?.startLine).toBe(7);
    expect(listClaim?.blockStartLine).toBe(6);
    expect(listClaim?.blockEndLine).toBe(7);

    const tableClaim = claims.find((c) => c.referentText === "docs/missing.md");
    expect(tableClaim?.blockKind).toBe("table-row");
    expect(tableClaim?.startLine).toBe(11);
    expect(tableClaim?.blockStartLine).toBe(11);
    expect(tableClaim?.blockEndLine).toBe(11);
  });
});
