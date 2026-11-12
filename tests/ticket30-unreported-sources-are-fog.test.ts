import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { analyzeRepository } from "../src/analyzer.js";

async function write(root: string, rel: string, content: string): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

describe("Ticket 30: source files missing from the coverage report count as fog", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefog-t30-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("reports a TS source file absent from LCOV with all executable lines in fog", async () => {
    await write(
      tmpDir,
      "src/a.ts",
      ["export function add(x: number, y: number): number {", "  return x + y;", "}"].join("\n"),
    );
    await write(
      tmpDir,
      "src/b.ts",
      [
        "export function sub(x: number, y: number): number {",
        "  const d = x - y;",
        "  return d;",
        "}",
      ].join("\n"),
    );
    await write(
      tmpDir,
      "coverage/lcov.info",
      [
        "TN:",
        "SF:src/a.ts",
        "FN:1,add",
        "FNDA:1,add",
        "DA:1,1",
        "DA:2,1",
        "LF:2",
        "LH:2",
        "end_of_record",
      ].join("\n"),
    );

    const report = await analyzeRepository({ rootDir: tmpDir });

    const b = report.files.find((f) => f.path === "src/b.ts");
    expect(b).toBeDefined();
    expect(b!.totalLoc).toBe(3);
    expect(b!.locByState.fog).toBe(3);
    expect(b!.locByState.verified + b!.locByState["weak-evidence"]).toBe(0);
    expect(report.summary.totalFiles).toBe(2);
    expect(report.summary.totalLoc).toBe(5);
  });

  it("reports .go files of a package absent from coverage.out as fog, excluding _test.go", async () => {
    await write(tmpDir, "go.mod", "module github.com/acme/pay\n\ngo 1.21\n");
    await write(
      tmpDir,
      "billing/fee.go",
      ["package billing", "", "func Fee(a int) int {", "\treturn a * 3", "}"].join("\n"),
    );
    await write(
      tmpDir,
      "ledger/post.go",
      ["package ledger", "", "func Post(a int) int {", "\tb := a + 1", "\treturn b", "}"].join("\n"),
    );
    await write(
      tmpDir,
      "ledger/post_test.go",
      [
        "package ledger",
        "",
        'import "testing"',
        "",
        "func TestPost(t *testing.T) {",
        "\tif Post(1) != 2 {",
        '\t\tt.Errorf("bad")',
        "\t}",
        "}",
      ].join("\n"),
    );
    await write(
      tmpDir,
      "coverage.out",
      ["mode: count", "github.com/acme/pay/billing/fee.go:3.22,5.2 1 1"].join("\n"),
    );

    const report = await analyzeRepository({ rootDir: tmpDir });

    const paths = report.files.map((f) => f.path).sort();
    expect(paths).toEqual(["billing/fee.go", "ledger/post.go"]);
    const post = report.files.find((f) => f.path === "ledger/post.go")!;
    expect(post.totalLoc).toBeGreaterThan(0);
    expect(post.locByState.fog).toBe(post.totalLoc);
  });

  it("does not add test files, declaration files, build output, gitignored files or tool configs", async () => {
    await write(tmpDir, "src/a.ts", "export const a = 1;\n");
    await write(tmpDir, "src/a.test.ts", "import { a } from './a';\nconsole.log(a);\n");
    await write(tmpDir, "src/env.d.ts", "declare const X: number;\n");
    await write(tmpDir, "dist/a.js", "export const a = 1;\n");
    await write(tmpDir, "generated/client.ts", "export const g = 1;\n");
    await write(tmpDir, ".gitignore", "generated/\n");
    await write(tmpDir, "vitest.config.ts", "export default {};\n");
    await write(tmpDir, "eslint.config.mjs", "export default [];\n");
    await write(
      tmpDir,
      "coverage/lcov.info",
      ["TN:", "SF:src/a.ts", "DA:1,1", "LF:1", "LH:1", "end_of_record"].join("\n"),
    );

    const report = await analyzeRepository({ rootDir: tmpDir });

    expect(report.files.map((f) => f.path)).toEqual(["src/a.ts"]);
  });
});
