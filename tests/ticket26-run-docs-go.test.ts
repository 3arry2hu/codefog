import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { analyzeRepository } from "../src/analyzer.js";
import { runCli } from "../src/cli.js";

const hasGo = spawnSync("go", ["version"]).status === 0;

describe("Ticket 26: Executable docs — Go code block execution evidence (--run-docs)", { timeout: 60_000 }, () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefog-t26-go-"));
    await fs.mkdir(path.join(tmpDir, "billing"), { recursive: true });

    await fs.writeFile(
      path.join(tmpDir, "go.mod"),
      "module example.com/pay\n\ngo 1.22\n",
      "utf8",
    );

    await fs.writeFile(
      path.join(tmpDir, "billing", "fee.go"),
      [
        "package billing",
        "",
        "func CalculateFee(amount int) int {",
        "  return (amount * 3) / 100",
        "}",
        "",
        "func TierLabels(amount int) []string {",
        "  if amount >= 100 {",
        '    return []string{"standard", "taxable"}',
        "  }",
        '  return []string{"micro"}',
        "}",
        "",
        "func Charge(amount int) (int, error) {",
        "  return amount + CalculateFee(amount), nil",
        "}",
      ].join("\n"),
      "utf8",
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it.skipIf(!hasGo)(
    "records Go code blocks as fog without --run-docs, and under --run-docs auto-wraps package-less Go blocks and marks passing value-comparison + panic blocks as verified",
    async () => {
    await fs.writeFile(
      path.join(tmpDir, "README.md"),
      [
        "# Pay Billing",
        "",
        "```go",
        'import "example.com/pay/billing"',
        "",
        "got := billing.CalculateFee(100)",
        "if got != 3 {",
        '  panic("unexpected fee")',
        "}",
        "```",
        "",
        "```go",
        "import (",
        '  "reflect"',
        '  "example.com/pay/billing"',
        ")",
        "",
        "labels := billing.TierLabels(100)",
        'want := []string{"standard", "taxable"}',
        "if !reflect.DeepEqual(labels, want) {",
        '  panic("tier labels mismatch")',
        "}",
        "```",
      ].join("\n"),
      "utf8",
    );

    // 1. Without --run-docs: Go code blocks are discovered and marked as fog
    const reportWithoutRun = await analyzeRepository({
      rootDir: tmpDir,
      docs: true,
    });
    const unrunClaims = (reportWithoutRun.docClaims ?? []).filter(
      (c) => c.kind === "code-block",
    );
    expect(unrunClaims.length).toBe(2);
    expect(unrunClaims[0]?.state).toBe("fog");
    expect(unrunClaims[1]?.state).toBe("fog");
    expect(reportWithoutRun.docTrustScore).toBe(0);

    // 2. With --run-docs: both blocks compile, execute, and pass with Outcome Assertions -> verified
    const reportWithRun = await analyzeRepository({
      rootDir: tmpDir,
      docs: true,
      runDocs: true,
    });
    const runClaims = (reportWithRun.docClaims ?? []).filter(
      (c) => c.kind === "code-block",
    );
    expect(runClaims.length).toBe(2);
    expect(runClaims[0]?.state).toBe("verified");
    expect(runClaims[1]?.state).toBe("verified");
    expect(reportWithRun.summary.totalDocClaims).toBe(2);
    expect(reportWithRun.summary.docClaimsByState?.verified).toBe(2);
    expect(reportWithRun.docTrustScore).toBe(100);
  });

  it.skipIf(!hasGo)(
    "classifies Go code blocks that only fmt.Println results (or only check err != nil without asserting on the returned value) as weak-evidence",
    async () => {
      await fs.writeFile(
        path.join(tmpDir, "README.md"),
        [
          "# Examples",
          "",
          "```go",
          'import "fmt"',
          'import "example.com/pay/billing"',
          "",
          "fmt.Println(billing.CalculateFee(100)) // => 3",
          'fmt.Println("require.Equal(t, 3, fee)")',
          "```",
          "",
          "```go",
          'import "fmt"',
          'import "example.com/pay/billing"',
          "",
          "total, err := billing.Charge(100)",
          "if err != nil {",
          "  panic(err)",
          "}",
          "fmt.Println(total)",
          "```",
          "",
          "```go",
          'import "example.com/pay/billing"',
          "",
          "got := billing.CalculateFee(100)",
          "if got != 3 {",
          '  panic("expected 3")',
          "}",
          "```",
        ].join("\n"),
        "utf8",
      );

      const report = await analyzeRepository({
        rootDir: tmpDir,
        docs: true,
        runDocs: true,
      });

      const claims = (report.docClaims ?? []).filter((c) => c.kind === "code-block");
      expect(claims.length).toBe(3);

      expect(claims[0]?.state).toBe("weak-evidence");
      expect(claims[1]?.state).toBe("weak-evidence");
      expect(claims[2]?.state).toBe("verified");

      // 2 weak-evidence (0.4 each) + 1 verified (1.0) = 1.8 / 3 = 0.6 -> 60
      expect(report.summary.docClaimsByState?.["weak-evidence"]).toBe(2);
      expect(report.summary.docClaimsByState?.verified).toBe(1);
      expect(report.docTrustScore).toBe(60);
      expect(report.findings.filter((f) => f.subjectType === "doc")).toEqual([]);
    },
  );

  it.skipIf(!hasGo)(
    "marks Go code blocks with compile errors (calling non-existent functions or omitting imports) or runtime panics as fog-returned with failure output in Finding, and exits 1 under --fail-on doc-returned",
    async () => {
      const sideEffectFile = path.join(tmpDir, "shell-side-effect.txt");

      await fs.writeFile(
        path.join(tmpDir, "README.md"),
        [
          "# Pay Verification",
          "",
          "```bash",
          `echo "should not run" > "${sideEffectFile.replace(/\\/g, "/")}"`,
          "```",
          "",
          "```go",
          "package main",
          "",
          'import "example.com/pay/billing"',
          "",
          "func main() {",
          "  if got := billing.CalculateFee(100); got != 3 {",
          '    panic("expected 3")',
          "  }",
          "}",
          "```",
          "",
          "```go",
          "// Calling CalculateFee bare without import must fail (no Go dot-import)",
          "if got := CalculateFee(100); got != 3 {",
          '  panic("expected 3")',
          "}",
          "```",
          "",
          "```go",
          'import "example.com/pay/billing"',
          "",
          "got := billing.NonExistentFunc(100)",
          "if got != 3 {",
          '  panic("unreachable")',
          "}",
          "```",
          "",
          "```go",
          'import "example.com/pay/billing"',
          "",
          "got := billing.CalculateFee(100)",
          "if got != 999 {",
          '  panic("fee mismatch: want 999")',
          "}",
          "```",
        ].join("\n"),
        "utf8",
      );

      let cliStdout = "";
      const exitCode = await runCli(
        ["--root", tmpDir, "--docs", "--run-docs", "--json", "--fail-on", "doc-returned"],
        {
          stdout: (s) => {
            cliStdout += s;
          },
          stderr: () => {},
        },
      );

      expect(exitCode).toBe(1);

      let sideEffectExists = false;
      try {
        await fs.access(sideEffectFile);
        sideEffectExists = true;
      } catch {
        sideEffectExists = false;
      }
      expect(sideEffectExists).toBe(false);

      const report = JSON.parse(cliStdout);
      const codeClaims = (report.docClaims ?? []).filter(
        (c: { kind: string }) => c.kind === "code-block",
      );
      expect(codeClaims.length).toBe(4);

      expect(codeClaims[0].state).toBe("verified");
      expect(codeClaims[1].state).toBe("fog-returned");
      expect(codeClaims[2].state).toBe("fog-returned");
      expect(codeClaims[3].state).toBe("fog-returned");

      expect(codeClaims[1].executionOutput).toMatch(/CalculateFee/);
      expect(codeClaims[2].executionOutput).toMatch(/NonExistentFunc/);
      expect(codeClaims[3].executionOutput).toMatch(/fee mismatch: want 999/);

      // 1 verified (+1.0) + 3 fog-returned (3 * -0.5 = -1.5) -> clamped to 0
      expect(report.summary.docClaimsByState.verified).toBe(1);
      expect(report.summary.docClaimsByState["fog-returned"]).toBe(3);
      expect(report.docTrustScore).toBe(0);

      const docFindings = report.findings.filter(
        (f: { subjectType?: string }) => f.subjectType === "doc",
      );
      expect(docFindings.length).toBe(3);

      const compileFinding = docFindings.find(
        (f: { location: { startLine: number } }) =>
          f.location.startLine === codeClaims[2].startLine,
      );
      const panicFinding = docFindings.find(
        (f: { location: { startLine: number } }) =>
          f.location.startLine === codeClaims[3].startLine,
      );

      expect(compileFinding?.state).toBe("fog-returned");
      expect(compileFinding?.tags).toContain("doc-fog-returned");
      expect(compileFinding?.reason).toMatch(/NonExistentFunc/);
      expect(panicFinding?.state).toBe("fog-returned");
      expect(panicFinding?.tags).toContain("doc-fog-returned");
      expect(panicFinding?.reason).toMatch(/fee mismatch: want 999/);
    },
  );
});
