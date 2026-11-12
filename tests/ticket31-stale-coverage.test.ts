import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { analyzeRepository } from "../src/analyzer.js";
import { runCli } from "../src/cli.js";
import { renderHtmlFogMap } from "../src/html-report.js";

async function write(root: string, rel: string, content: string): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

async function setMtime(root: string, rel: string, date: Date): Promise<void> {
  await fs.utimes(path.join(root, rel), date, date);
}

describe("Ticket 31: warn when the coverage report is older than the source it describes", () => {
  let tmpDir: string;
  const coverageTime = new Date("2026-10-20T10:00:00Z");

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefog-t31-"));
    await write(tmpDir, "src/a.ts", "export function a(): number {\n  return 1;\n}\n");
    await write(tmpDir, "src/b.ts", "export function b(): number {\n  return 2;\n}\n");
    await write(
      tmpDir,
      "coverage/lcov.info",
      [
        "TN:",
        "SF:src/a.ts",
        "DA:1,1",
        "DA:2,1",
        "LF:2",
        "LH:2",
        "end_of_record",
        "TN:",
        "SF:src/b.ts",
        "DA:1,1",
        "DA:2,1",
        "LF:2",
        "LH:2",
        "end_of_record",
      ].join("\n"),
    );
    await setMtime(tmpDir, "coverage/lcov.info", coverageTime);
    await setMtime(tmpDir, "src/a.ts", new Date("2026-10-19T10:00:00Z"));
    await setMtime(tmpDir, "src/b.ts", new Date("2026-10-19T10:00:00Z"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("warns and names the newest source file when a covered file changed after coverage was generated", async () => {
    await setMtime(tmpDir, "src/b.ts", new Date("2026-11-01T10:00:00Z"));

    const report = await analyzeRepository({ rootDir: tmpDir });

    const stale = report.warnings?.find((w) => w.includes("older than"));
    expect(stale).toBeDefined();
    expect(stale).toContain("coverage/lcov.info");
    expect(stale).toContain("src/b.ts");
    expect(stale).not.toContain("src/a.ts");
  });

  it("does not warn when coverage was generated after every source change", async () => {
    const report = await analyzeRepository({ rootDir: tmpDir });

    expect(report.warnings ?? []).toEqual([]);
  });

  it("prints the warning on stderr, keeps --json stdout parseable and leaves the exit code alone", async () => {
    await setMtime(tmpDir, "src/a.ts", new Date("2026-11-01T10:00:00Z"));
    let stdout = "";
    let stderr = "";

    const code = await runCli(["--root", tmpDir, "--json"], {
      stdout: (s) => (stdout += s),
      stderr: (s) => (stderr += s),
    });

    expect(code).toBe(0);
    expect(stderr).toContain("older than src/a.ts");
    const json = JSON.parse(stdout);
    expect(json.warnings.some((w: string) => w.includes("older than src/a.ts"))).toBe(true);
    expect(json.files.find((f: { path: string }) => f.path === "src/a.ts").locByState.fog).toBe(0);
  });

  it("shows the warning on Fog Map Level 1", async () => {
    await setMtime(tmpDir, "src/b.ts", new Date("2026-11-01T10:00:00Z"));
    const report = await analyzeRepository({ rootDir: tmpDir });

    const html = renderHtmlFogMap(report);

    expect(html).toContain('class="report-warning"');
    expect(html).toContain("is older than src/b.ts");
  });
});
