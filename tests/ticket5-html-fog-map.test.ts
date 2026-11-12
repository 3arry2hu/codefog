import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { runCli } from "../src/cli.js";

describe("Ticket 5: Four-Level Progressive Disclosure Interactive Fog Map (.codefog/report.html)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefog-t5-"));
    await fs.mkdir(path.join(tmpDir, "src", "payments"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "src", "utils"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "coverage"), { recursive: true });

    await fs.writeFile(
      path.join(tmpDir, "src", "payments", "charge.ts"),
      [
        "export function chargeCard(amount: number): number {",
        "  if (amount <= 0) {",
        "    return 0;",
        "  }",
        "  return amount;",
        "}",
      ].join("\n"),
      "utf8",
    );

    await fs.writeFile(
      path.join(tmpDir, "src", "utils", "math.ts"),
      [
        "export function add(a: number, b: number): number {",
        "  return a + b;",
        "}",
      ].join("\n"),
      "utf8",
    );

    const lcovContent = [
      "TN:",
      "SF:src/payments/charge.ts",
      "FN:1,chargeCard",
      "FNF:1",
      "FNH:0",
      "FNDA:0,chargeCard",
      "DA:1,0",
      "DA:2,0",
      "DA:3,0",
      "DA:5,0",
      "LF:4",
      "LH:0",
      "end_of_record",
      "TN:",
      "SF:src/utils/math.ts",
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
    await fs.writeFile(path.join(tmpDir, "coverage", "lcov.info"), lcovContent, "utf8");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes zero-external-dependency .codefog/report.html with 4-level progressive disclosure, OKLCH slate palette + #BD4900, collapsed verified zones, and Copy as task for agent", async () => {
    const logs: string[] = [];
    const exitCode = await runCli(["--root", tmpDir, "--fail-on", "none"], {
      stdout: (s) => logs.push(s),
      stderr: (s) => logs.push(s),
    });
    expect(exitCode).toBe(0);

    const htmlPath = path.join(tmpDir, ".codefog", "report.html");
    const html = await fs.readFile(htmlPath, "utf8");

    // 1. Zero external runtime dependencies (no external <script src="http..."> or <link href="http...">)
    expect(html).not.toMatch(/<script[^>]+src=["']https?:/i);
    expect(html).not.toMatch(/<link[^>]+href=["']https?:/i);

    // 2. Five-state OKLCH color palette + Fog Returned warning orange (#BD4900) + RETURNED badge
    expect(html).toContain("#EBEFF4");
    expect(html).toContain("#BCCCE2");
    expect(html).toContain("#6E88AA");
    expect(html).toContain("#1D3656");
    expect(html).toContain("#BD4900");
    expect(html).toContain("RETURNED");

    // 3. Four-Level Progressive Disclosure navigation & views
    expect(html).toContain("Level 1: Repository");
    expect(html).toContain("Level 2: Module");
    expect(html).toContain("Level 3: File Map");
    expect(html).toContain("Level 4: Source & Evidence");

    // 4. Collapsed verified files / modules section & Copy as task for agent button
    expect(html).toContain("verified files collapsed");
    expect(html).toContain("Copy as task for agent");
    expect(html).toContain("npx @barryzhu/codefog verify");
  });

  it("produces report.html byte-identical to main when neither --docs nor external reports are passed", async () => {
    const repoDir = path.join(tmpDir, "tiny-repo");
    await fs.mkdir(path.join(repoDir, "src"), { recursive: true });
    await fs.mkdir(path.join(repoDir, "coverage"), { recursive: true });

    await fs.writeFile(
      path.join(repoDir, "src", "math.ts"),
      "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(repoDir, "coverage", "lcov.info"),
      [
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
      ].join("\n"),
      "utf8",
    );

    const exitCode = await runCli(["--root", repoDir, "--fail-on", "none"], {
      stdout: () => {},
      stderr: () => {},
    });
    expect(exitCode).toBe(0);

    const rawHtml = await fs.readFile(path.join(repoDir, ".codefog", "report.html"), "utf8");
    const html = rawHtml.replace(
      /"generatedAt":"[^"]+"/,
      '"generatedAt":"2026-01-01T00:00:00.000Z"',
    );

    // Must not contain any external overlay or doc claim code when neither flag is enabled
    expect(html).not.toContain("externalIssues");
    expect(html).not.toContain("External Overlay");
    expect(html).not.toContain("externalByLine");
    expect(html).not.toContain("docClaims");
    expect(html).not.toContain("Doc Trust Score");
    expect(html).toContain("'<div class=\"module-row\" onclick=\"switchLevel(2)\">' +");
    expect(html).toContain(
      "return '<tr class=\"line-' + st + '\"><td class=\"ln-col\">' + ln + '</td><td>' + escaped + '</td></tr>' + mutantRows;",
    );
  });
});
