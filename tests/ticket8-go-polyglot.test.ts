import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { analyzeRepository } from "../src/analyzer.js";
import { runCli } from "../src/cli.js";
import { verifyTargetWithMutants } from "../src/verify.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

describe("Ticket #9 (Ticket 1): Go (golang) end-to-end slice & --coverage ingestion", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefog-t8-go-"));
    await git(tmpDir, ["init", "-b", "main"]);
    await git(tmpDir, ["config", "user.name", "Test Bot"]);
    await git(tmpDir, ["config", "user.email", "bot@example.com"]);
    await fs.mkdir(path.join(tmpDir, "internal", "billing"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("auto-detects Go coverage.out, classifies Go Outcome Assertions vs Liveness Checks, ignores GoDoc edits, and flags Fog Returned on runtime edits", async () => {
    const srcFile = path.join(tmpDir, "internal", "billing", "service.go");
    const testFile = path.join(tmpDir, "internal", "billing", "service_test.go");
    const coverFile = path.join(tmpDir, "coverage.out");

    await fs.writeFile(
      path.join(tmpDir, "go.mod"),
      "module github.com/acme/pay\n\ngo 1.22\n",
      "utf8",
    );

    // Commit 1: Go production source file with 3 functions/methods:
    // 1. ValidateCurrency(code string) error (lines 5-10)
    // 2. (s *BillingService) Charge(amount int) (int, error) (lines 14-19)
    // 3. AuditLog(event string) string (lines 21-23)
    const initialGoSource = [
      "package billing",
      "",
      'import "errors"',
      "",
      "func ValidateCurrency(code string) error {",
      '  if code == "" {',
      '    return errors.New("empty currency")',
      "  }",
      "  return nil",
      "}",
      "",
      "type BillingService struct{}",
      "",
      "func (s *BillingService) Charge(amount int) (int, error) {",
      "  if amount <= 0 {",
      '    return 0, errors.New("invalid amount")',
      "  }",
      "  return amount + 5, nil",
      "}",
      "",
      "func AuditLog(event string) string {",
      '  return "audit:" + event',
      "}",
    ].join("\n");

    await fs.writeFile(srcFile, initialGoSource, "utf8");
    await git(tmpDir, ["add", "."]);
    await git(tmpDir, ["commit", "-m", "feat(billing): add Go billing service"]);

    // Commit 2: Go test file in the same package (`package billing`, no import needed for same-package calls):
    // - TestValidateCurrency: checks `err != nil` and `err == nil` on error-only function -> Outcome Assertion!
    // - TestChargeLivenessOnly: calls `total, err := svc.Charge(100)` and ONLY checks `if err != nil { t.Fatal(err) }`, never asserting on `total` -> Liveness Check (`weak-evidence`, `assertionsOnOutcome: 0`, `pseudoTested: false`)!
    // - TestAuditSmoke: calls `_ = AuditLog("init")` with zero assertions -> `pseudoTested: true`, `weak-evidence`!
    const goTestSource = [
      "package billing",
      "",
      'import "testing"',
      "",
      "func TestValidateCurrency(t *testing.T) {",
      '  if err := ValidateCurrency("USD"); err != nil {',
      '    t.Errorf("expected nil error, got %v", err)',
      "  }",
      '  if err := ValidateCurrency(""); err == nil {',
      '    t.Fatalf("expected error for empty currency")',
      "  }",
      "}",
      "",
      "func TestChargeLivenessOnly(t *testing.T) {",
      "  svc := &BillingService{}",
      "  _, err := svc.Charge(100)",
      "  if err != nil {",
      "    t.Fatal(err)",
      "  }",
      "}",
      "",
      "func TestAuditSmoke(t *testing.T) {",
      '  _ = AuditLog("init")',
      "}",
    ].join("\n");

    await fs.writeFile(testFile, goTestSource, "utf8");

    // Go coverprofile (`coverage.out`):
    // ValidateCurrency (5-10): both branches covered
    // Charge (14-19): both branches covered (to isolate Liveness Check vs branch coverage)
    // AuditLog (21-23): covered
    const coverProfileContent = [
      "mode: count",
      "github.com/acme/pay/internal/billing/service.go:5.42,6.16 1 2",
      "github.com/acme/pay/internal/billing/service.go:6.16,8.4 1 1",
      "github.com/acme/pay/internal/billing/service.go:9.3,9.13 1 1",
      "github.com/acme/pay/internal/billing/service.go:14.58,15.17 1 2",
      "github.com/acme/pay/internal/billing/service.go:15.17,17.4 1 1",
      "github.com/acme/pay/internal/billing/service.go:18.3,18.25 1 1",
      "github.com/acme/pay/internal/billing/service.go:21.37,23.2 1 1",
    ].join("\n");

    await fs.writeFile(coverFile, coverProfileContent, "utf8");
    await git(tmpDir, ["add", "."]);
    await git(tmpDir, ["commit", "-m", "test(billing): add Go tests and coverage.out"]);

    const report1 = await analyzeRepository({ rootDir: tmpDir });

    expect(report1.summary.totalFiles).toBe(1);
    expect(report1.modules[0]?.path).toBe("internal/billing");

    const file1 = report1.files[0]!;
    expect(file1.path).toBe("internal/billing/service.go");

    const validateReg = file1.regions.find((r) => r.symbol === "ValidateCurrency");
    const chargeReg = file1.regions.find((r) => r.symbol === "Charge");
    const auditReg = file1.regions.find((r) => r.symbol === "AuditLog");

    expect(validateReg?.state).toBe("verified");
    expect(validateReg?.assertionsOnOutcome).toBeGreaterThanOrEqual(1);
    expect(validateReg?.pseudoTested).toBe(false);

    // Charge only had `if err != nil { t.Fatal(err) }` on a `(int, error)` return -> Liveness Check (`weak-evidence`, 0 outcome assertions, pseudo-tested because `{ return 0, nil }` still passes!)
    expect(chargeReg?.state).toBe("weak-evidence");
    expect(chargeReg?.assertionsOnOutcome).toBe(0);
    expect(chargeReg?.pseudoTested).toBe(true);

    // AuditLog had 0 assertions of any kind -> pseudo-tested (`weak-evidence`, `pseudoTested: true`)
    expect(auditReg?.state).toBe("weak-evidence");
    expect(auditReg?.assertionsOnOutcome).toBe(0);
    expect(auditReg?.pseudoTested).toBe(true);
    expect(report1.summary.metrics.pseudoTestedMethods).toBe(2);

    // Commit 3: Add GoDoc comments to ValidateCurrency -> must NOT trigger Fog Returned
    const commentedGoSource = initialGoSource.replace(
      "func ValidateCurrency(code string) error {",
      "// ValidateCurrency checks ISO currency code.\nfunc ValidateCurrency(code string) error {",
    );
    await fs.writeFile(srcFile, commentedGoSource, "utf8");
    await git(tmpDir, ["add", "internal/billing/service.go"]);
    await git(tmpDir, ["commit", "-m", "docs(billing): add GoDoc comment to ValidateCurrency"]);

    const reportAfterComment = await analyzeRepository({ rootDir: tmpDir });
    const validateAfterComment = reportAfterComment.files[0]?.regions.find(
      (r) => r.symbol === "ValidateCurrency",
    );
    expect(validateAfterComment?.state).toBe("verified");

    // Commit 4: Modify runtime logic in ValidateCurrency without updating tests -> triggers Fog Returned!
    const modifiedGoSource = commentedGoSource.replace(
      'if code == "" {',
      'if len(code) != 3 {',
    );
    await fs.writeFile(srcFile, modifiedGoSource, "utf8");
    await git(tmpDir, ["add", "internal/billing/service.go"]);
    await git(tmpDir, ["commit", "-m", "feat(billing): require 3-letter currency code"]);

    let cliStdout = "";
    const exitCode = await runCli(
      ["--root", tmpDir, "--coverage", "coverage.out", "--json", "--fail-on", "returned"],
      {
        stdout: (s) => {
          cliStdout += s;
        },
        stderr: () => {},
      },
    );
    expect(exitCode).toBe(1);
    const reportAfterRuntimeEdit = JSON.parse(cliStdout);
    const validateAfterEdit = reportAfterRuntimeEdit.files[0].regions.find(
      (r: { symbol: string }) => r.symbol === "ValidateCurrency",
    );
    expect(validateAfterEdit.state).toBe("fog-returned");
  });

  it("supports `codefog verify <file.go> --mutants` with type-valid Go zero-value body clearance and CompileError exemption", async () => {
    const guardFile = path.join(tmpDir, "internal", "billing", "guard.go");
    const testFile = path.join(tmpDir, "internal", "billing", "guard_test.go");
    const runnerScript = path.join(tmpDir, "run-go-check.mjs");

    const goGuardSource = [
      "package billing",
      "",
      "func CanRefund(days int) (bool, error) {",
      "  if days <= 30 {",
      "    return true, nil",
      "  }",
      "  return false, nil",
      "}",
    ].join("\n");
    await fs.writeFile(guardFile, goGuardSource, "utf8");

    // Initial test only checks days = 10 (misses boundary 30, so `days <= 30` -> `days < 30` survives!)
    await fs.writeFile(
      testFile,
      [
        "package billing",
        'import "testing"',
        "func TestCanRefund(t *testing.T) {",
        "  ok, err := CanRefund(10)",
        "  if err != nil || !ok {",
        '    t.Errorf("expected true, got %v", ok)',
        "  }",
        "}",
      ].join("\n"),
      "utf8",
    );

    // Simulated fast Go compiler + test runner that enforces Go return signature `(bool, error)` (rejecting non-type-valid bodies with Go compiler error) and evaluates CanRefund
    await fs.writeFile(
      runnerScript,
      [
        "import * as fs from 'node:fs';",
        "const src = fs.readFileSync('internal/billing/guard.go', 'utf8');",
        "const test = fs.readFileSync('internal/billing/guard_test.go', 'utf8');",
        "if (src.includes('undefined') || !/return\\s+(true|false)\\s*,\\s*nil/.test(src)) {",
        "  console.error('./guard.go:4:2: cannot use undefined as (bool, error) value in return statement');",
        "  process.exit(2);",
        "}",
        "let fn;",
        "if (src.includes('days <= 30')) fn = (d) => [d <= 30, null];",
        "else if (src.includes('days < 30')) fn = (d) => [d < 30, null];",
        "else if (src.includes('days > 30')) fn = (d) => [d > 30, null];",
        "else fn = (_d) => [false, null];",
        "if (test.includes('CanRefund(10)') && fn(10)[0] !== true) process.exit(1);",
        "if (test.includes('CanRefund(30)') && fn(30)[0] !== true) process.exit(1);",
        "if (test.includes('CanRefund(31)') && fn(31)[0] !== false) process.exit(1);",
        "process.exit(0);",
      ].join("\n"),
      "utf8",
    );

    await git(tmpDir, ["add", "."]);
    await git(tmpDir, ["commit", "-m", "feat(billing): add Go refund guard"]);

    // 1. Fails when boundary mutant `days <= 30` -> `days < 30` survives
    const res1 = await verifyTargetWithMutants({
      rootDir: tmpDir,
      targetFile: "internal/billing/guard.go",
      mutants: true,
      testCmd: "node run-go-check.mjs",
    });
    expect(res1.passed).toBe(false);
    expect(res1.survivingMutants.some((m) => m.mutated.includes("days < 30"))).toBe(true);

    // 2. Strengthen Go test with boundary assertions on 30 and 31 -> all mutants killed!
    await fs.writeFile(
      testFile,
      [
        "package billing",
        'import "testing"',
        "func TestCanRefund(t *testing.T) {",
        "  if ok, err := CanRefund(10); err != nil || !ok { t.Errorf(\"want true\") }",
        "  if ok, err := CanRefund(30); err != nil || !ok { t.Errorf(\"want true at boundary 30\") }",
        "  if ok, err := CanRefund(31); err != nil || ok { t.Errorf(\"want false at 31\") }",
        "}",
      ].join("\n"),
      "utf8",
    );

    const res2 = await verifyTargetWithMutants({
      rootDir: tmpDir,
      targetFile: "internal/billing/guard.go",
      mutants: true,
      testCmd: "node run-go-check.mjs",
    });
    expect(res2.passed).toBe(true);
    expect(res2.killedMutants).toBeGreaterThanOrEqual(3);

    // 3. Verify npm exec / npx stripped-flag recovery (`coverage.out` and `none` passed as positional args)
    // and fallback to zero-hit repo synthesis when `coverage.out` does not exist on disk yet
    let cliOut = "";
    let cliErr = "";
    const code = await runCli(["--root", tmpDir, "coverage.out", "none"], {
      stdout: (s) => {
        cliOut += s;
      },
      stderr: (s) => {
        cliErr += s;
      },
    });
    expect(code).toBe(0);
    expect(cliErr).toBe("");
    expect(cliOut).toContain("Trust Score:");
    expect(cliOut).toContain("CanRefund");
  });
});
