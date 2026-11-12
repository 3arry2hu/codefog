import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runCli } from "../src/cli.js";
import { renderHtmlFogMap } from "../src/html-report.js";
import type { CodefogReport } from "../src/types.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function write(root: string, rel: string, content: string): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

describe("Ticket 34: generated commands use the published package name", () => {
  let tmpDir: string;
  let report: CodefogReport;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefog-t34-"));
    await git(tmpDir, ["init", "-q", "-b", "main"]);
    await git(tmpDir, ["config", "user.email", "t34@codefog.dev"]);
    await git(tmpDir, ["config", "user.name", "t34"]);
    await write(tmpDir, "src/a.ts", "export function a(x: number): number {\n  return x + 1;\n}\n");
    await write(tmpDir, "README.md", "# Demo\n\nSee `src/missing-guide.ts` for details.\n");
    await write(tmpDir, "AGENTS.md", "# Agents\n\nRun tests with `npm test`.\n");
    await write(tmpDir, "CLAUDE.md", "# Claude\n\nRun tests with `npx vitest run`.\n");
    await write(tmpDir, "package.json", JSON.stringify({ name: "demo", scripts: { test: "vitest run" } }));
    await git(tmpDir, ["add", "."]);
    await git(tmpDir, ["commit", "-q", "-m", "init"]);

    let stdout = "";
    const code = await runCli(
      ["--root", tmpDir, "--docs", "--json", "--pr-comment", ".codefog", "--fail-on", "none"],
      { stdout: (s) => (stdout += s), stderr: () => {} },
    );
    expect(code).toBe(0);
    report = JSON.parse(stdout);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("uses npx @barryzhu/codefog in code, doc and instruction-conflict acceptance checks", () => {
    const kinds = new Set(report.findings.map((f) => f.subjectType ?? "code"));
    expect(kinds.has("doc")).toBe(true);
    expect(report.findings.some((f) => f.tags?.includes("instruction-conflict"))).toBe(true);
    expect(report.findings.some((f) => f.location.file === "src/a.ts")).toBe(true);

    for (const f of report.findings) {
      expect(f.acceptanceCheck.command).toMatch(/^npx @barryzhu\/codefog verify /);
    }
  });

  it("uses npx @barryzhu/codefog in the PR comment Verify lines", async () => {
    const md = await fs.readFile(path.join(tmpDir, ".codefog", "pr-comment.md"), "utf8");

    expect(md).toContain("Verify: `npx @barryzhu/codefog verify README.md");
    expect(md).not.toContain("npx codefog");
  });

  it("uses npx @barryzhu/codefog in the empty-findings example of the Fog Map", () => {
    const html = renderHtmlFogMap({ ...report, findings: [] });

    expect(html).toContain("npx @barryzhu/codefog verify");
    expect(html).not.toContain("npx codefog");
  });
});
