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

async function runCapture(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
  });
  return { code, stdout, stderr };
}

describe("Ticket 33: --diff fails loudly when the base ref cannot be resolved", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefog-t33-"));
    await git(tmpDir, ["init", "-q", "-b", "main"]);
    await git(tmpDir, ["config", "user.email", "t33@codefog.dev"]);
    await git(tmpDir, ["config", "user.name", "t33"]);
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "src", "a.ts"),
      "export function a(): number {\n  return 1;\n}\n",
      "utf8",
    );
    await git(tmpDir, ["add", "."]);
    await git(tmpDir, ["commit", "-q", "-m", "init"]);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("exits 1 with a fetch-depth hint and writes no PR artifacts for an unknown base ref", async () => {
    const { code, stderr } = await runCapture([
      "--root",
      tmpDir,
      "--diff",
      "origin/nope",
      "--pr-comment",
      ".codefog",
      "--fail-on",
      "none",
    ]);

    expect(code).toBe(1);
    expect(stderr).toContain("origin/nope");
    expect(stderr).toContain("fetch-depth: 0");
    await expect(fs.access(path.join(tmpDir, ".codefog", "pr-comment.md"))).rejects.toThrow();
  });

  it("refuses to pass the regression gate when the base commit is missing from a single-commit clone", async () => {
    const { code, stderr } = await runCapture([
      "--root",
      tmpDir,
      "--diff",
      "HEAD~1",
      "--fail-on",
      "regression",
    ]);

    expect(code).toBe(1);
    expect(stderr).toContain("HEAD~1");
  });

  it("still compares against a resolvable base ref", async () => {
    await fs.writeFile(
      path.join(tmpDir, "src", "b.ts"),
      "export function b(): number {\n  return 2;\n}\n",
      "utf8",
    );
    await git(tmpDir, ["add", "."]);
    await git(tmpDir, ["commit", "-q", "-m", "add b"]);

    const { code, stdout } = await runCapture([
      "--root",
      tmpDir,
      "--diff",
      "HEAD~1",
      "--json",
      "--fail-on",
      "none",
    ]);

    expect(code).toBe(0);
    expect(JSON.parse(stdout).diff).toBeDefined();
  });
});
