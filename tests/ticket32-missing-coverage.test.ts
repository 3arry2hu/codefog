import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { analyzeRepository } from "../src/analyzer.js";
import { runCli } from "../src/cli.js";

async function write(root: string, rel: string, content: string): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
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

describe("Ticket 32: missing coverage is an error when explicit and a warning when auto-detected", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefog-t32-"));
    await write(tmpDir, "src/a.ts", "export function a(): number {\n  return 1;\n}\n");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("exits 1 and names the path when an explicit --coverage file does not exist", async () => {
    const { code, stdout, stderr } = await runCapture([
      "--root",
      tmpDir,
      "--coverage",
      "nope.info",
      "--fail-on",
      "none",
    ]);

    expect(code).toBe(1);
    expect(stderr).toContain("nope.info");
    expect(stdout).toBe("");
    await expect(fs.access(path.join(tmpDir, ".codefog", "report.html"))).rejects.toThrow();
  });

  it("treats a coverage path recovered from positional args (old npx stripping --coverage) as explicit", async () => {
    const { code, stderr } = await runCapture(["--root", tmpDir, "coverage.out", "none"]);

    expect(code).toBe(1);
    expect(stderr).toContain("coverage.out");
  });

  it("lists only the missing entries of a comma-separated --coverage value", async () => {
    await write(
      tmpDir,
      "a.info",
      ["TN:", "SF:src/a.ts", "DA:1,1", "DA:2,1", "LF:2", "LH:2", "end_of_record"].join("\n"),
    );

    const { code, stderr } = await runCapture([
      "--root",
      tmpDir,
      "--coverage",
      "a.info,nope.info",
      "--fail-on",
      "none",
    ]);

    expect(code).toBe(1);
    expect(stderr).toContain("nope.info");
    expect(stderr).not.toContain("a.info,");
    expect(stderr).not.toMatch(/\ba\.info\b/);
  });

  it("warns with the Go coverage recipe when no coverage report is auto-detected", async () => {
    const goDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefog-t32-go-"));
    try {
      await write(goDir, "go.mod", "module github.com/acme/pay\n\ngo 1.21\n");
      await write(
        goDir,
        "billing/fee.go",
        ["package billing", "", "func Fee(a int) int {", "\treturn a * 3", "}"].join("\n"),
      );

      const report = await analyzeRepository({ rootDir: goDir });
      expect(report.files.map((f) => f.path)).toEqual(["billing/fee.go"]);
      expect(report.warnings?.some((w) => w.includes("go test -coverprofile"))).toBe(true);

      const { code, stdout, stderr } = await runCapture(["--root", goDir, "--json", "--fail-on", "none"]);
      expect(code).toBe(0);
      expect(stderr).toContain("go test -coverprofile");
      const json = JSON.parse(stdout);
      expect(json.warnings.some((w: string) => w.includes("go test -coverprofile"))).toBe(true);
    } finally {
      await fs.rm(goDir, { recursive: true, force: true });
    }
  });

  it("reports that no source files were found instead of blaming LCOV in an empty directory", async () => {
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefog-t32-empty-"));
    try {
      const { code, stderr } = await runCapture(["--root", emptyDir, "--fail-on", "none"]);
      expect(code).toBe(1);
      expect(stderr).toContain(
        "No TypeScript/JavaScript, Go, Rust or Java source files found under",
      );
      expect(stderr).not.toContain("Could not read LCOV coverage file");
    } finally {
      await fs.rm(emptyDir, { recursive: true, force: true });
    }
  });
});
