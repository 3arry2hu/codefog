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

describe("Ticket #11 (Ticket 3): Java end-to-end slice (JaCoCo XML, JUnit/AssertJ, PITest XML, verify) & 4-Language Polyglot Repo", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefog-t11-java-"));
    await git(tmpDir, ["init", "-b", "main"]);
    await git(tmpDir, ["config", "user.name", "Test Bot"]);
    await git(tmpDir, ["config", "user.email", "bot@example.com"]);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("auto-detects JaCoCo XML, classifies JUnit/AssertJ Outcome Assertions vs assertNotNull Liveness Checks, ingests PITest mutations.xml, and supports `codefog verify <File.java> --mutants`", async () => {
    const javaSrcDir = path.join(tmpDir, "src", "main", "java", "com", "acme", "order");
    const javaTestDir = path.join(tmpDir, "src", "test", "java", "com", "acme", "order");
    const jacocoDir = path.join(tmpDir, "target", "site", "jacoco");
    await fs.mkdir(javaSrcDir, { recursive: true });
    await fs.mkdir(javaTestDir, { recursive: true });
    await fs.mkdir(jacocoDir, { recursive: true });

    const javaSrcFile = path.join(javaSrcDir, "OrderCalculator.java");
    const javaTestFile = path.join(javaTestDir, "OrderCalculatorTest.java");
    const jacocoXmlFile = path.join(jacocoDir, "jacoco.xml");
    const pitestXmlFile = path.join(tmpDir, "mutations.xml");
    const runnerScript = path.join(tmpDir, "run-java-check.mjs");

    // Commit 1: Java production source with 3 methods:
    // - calculateTax(int cents) (lines 4-9): tested with `assertEquals(20, calc.calculateTax(200))`
    // - createReceipt(int id) (lines 11-13): tested ONLY with `assertNotNull(calc.createReceipt(1))` -> Liveness Check (`weak-evidence`, `assertionsOnOutcome: 0`, `pseudoTested: true`)
    // - warmCache() (lines 15-17): called with 0 assertions -> `pseudoTested: true`, `weak-evidence`
    const initialJavaSource = [
      "package com.acme.order;",
      "",
      "public class OrderCalculator {",
      "    public int calculateTax(int cents) {",
      "        if (cents <= 10) {",
      "            return 0;",
      "        }",
      "        return cents / 10;",
      "    }",
      "",
      "    public String createReceipt(int id) {",
      '        return "RCPT-" + id;',
      "    }",
      "",
      "    public void warmCache() {",
      "        int x = 1;",
      "    }",
      "}",
    ].join("\n");

    await fs.writeFile(javaSrcFile, initialJavaSource, "utf8");
    await git(tmpDir, ["add", "."]);
    await git(tmpDir, ["commit", "-m", "feat(order): add OrderCalculator.java"]);

    // Commit 2: JUnit 5 test + JaCoCo XML report
    const javaTestSource = [
      "package com.acme.order;",
      "",
      "import org.junit.jupiter.api.Test;",
      "import static org.junit.jupiter.api.Assertions.*;",
      "",
      "public class OrderCalculatorTest {",
      "    @Test",
      "    public void testCalculateTax() {",
      "        OrderCalculator calc = new OrderCalculator();",
      "        assertEquals(0, calc.calculateTax(0));",
      "        assertEquals(20, calc.calculateTax(200));",
      "    }",
      "",
      "    @Test",
      "    public void testCreateReceiptLivenessOnly() {",
      "        OrderCalculator calc = new OrderCalculator();",
      "        String rcpt = calc.createReceipt(1);",
      "        assertNotNull(rcpt);",
      "    }",
      "",
      "    @Test",
      "    public void testWarmCacheSmoke() {",
      "        OrderCalculator calc = new OrderCalculator();",
      "        calc.warmCache();",
      "    }",
      "}",
    ].join("\n");
    await fs.writeFile(javaTestFile, javaTestSource, "utf8");

    const jacocoXml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<report name="acme-order">',
      '  <package name="com/acme/order">',
      '    <sourcefile name="OrderCalculator.java">',
      '      <line nr="5" mi="0" ci="3" mb="0" cb="2"/>',
      '      <line nr="6" mi="0" ci="1" mb="0" cb="0"/>',
      '      <line nr="8" mi="0" ci="2" mb="0" cb="0"/>',
      '      <line nr="12" mi="0" ci="2" mb="0" cb="0"/>',
      '      <line nr="16" mi="0" ci="1" mb="0" cb="0"/>',
      "    </sourcefile>",
      "  </package>",
      "</report>",
    ].join("\n");
    await fs.writeFile(jacocoXmlFile, jacocoXml, "utf8");

    await git(tmpDir, ["add", "."]);
    await git(tmpDir, ["commit", "-m", "test(order): add OrderCalculatorTest and jacoco.xml"]);

    const report1 = await analyzeRepository({ rootDir: tmpDir });
    expect(report1.summary.totalFiles).toBe(1);
    const file1 = report1.files[0]!;
    expect(file1.path).toBe("src/main/java/com/acme/order/OrderCalculator.java");

    const taxReg = file1.regions.find((r) => r.symbol === "calculateTax");
    const rcptReg = file1.regions.find((r) => r.symbol === "createReceipt");
    const warmReg = file1.regions.find((r) => r.symbol === "warmCache");

    expect(taxReg?.state).toBe("verified");
    expect(taxReg?.assertionsOnOutcome).toBeGreaterThanOrEqual(1);
    expect(taxReg?.pseudoTested).toBe(false);

    // createReceipt only had `assertNotNull(rcpt)` -> Liveness Check (`weak-evidence`, 0 outcome assertions, `pseudoTested: true`)
    expect(rcptReg?.state).toBe("weak-evidence");
    expect(rcptReg?.assertionsOnOutcome).toBe(0);
    expect(rcptReg?.pseudoTested).toBe(true);

    // warmCache had 0 assertions -> `weak-evidence`, `pseudoTested: true`
    expect(warmReg?.state).toBe("weak-evidence");
    expect(warmReg?.assertionsOnOutcome).toBe(0);
    expect(warmReg?.pseudoTested).toBe(true);

    // Ingest PITest XML (`mutations.xml`) with 1 KILLED and 1 SURVIVED on line 5 of calculateTax -> downgrades calculateTax to `weak-evidence`
    const pitestXml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      "<mutations>",
      '  <mutation detected="false" status="SURVIVED" numberOfTestsRun="1">',
      "    <sourceFile>OrderCalculator.java</sourceFile>",
      "    <mutatedClass>com.acme.order.OrderCalculator</mutatedClass>",
      "    <mutatedMethod>calculateTax</mutatedMethod>",
      "    <lineNumber>5</lineNumber>",
      "    <mutator>org.pitest.mutationtest.engine.gregor.mutators.ConditionalsBoundaryMutator</mutator>",
      "    <description>changed conditional boundary</description>",
      "  </mutation>",
      '  <mutation detected="true" status="KILLED" numberOfTestsRun="2">',
      "    <sourceFile>OrderCalculator.java</sourceFile>",
      "    <mutatedClass>com.acme.order.OrderCalculator</mutatedClass>",
      "    <mutatedMethod>calculateTax</mutatedMethod>",
      "    <lineNumber>8</lineNumber>",
      "    <mutator>org.pitest.mutationtest.engine.gregor.mutators.MathMutator</mutator>",
      "    <description>Replaced integer division with multiplication</description>",
      "  </mutation>",
      "</mutations>",
    ].join("\n");
    await fs.writeFile(pitestXmlFile, pitestXml, "utf8");

    const reportWithPitest = await analyzeRepository({
      rootDir: tmpDir,
      mutationReportPath: "mutations.xml",
    });
    expect(reportWithPitest.summary.metrics.mutationScorePct).toBe(50);
    const taxWithPitest = reportWithPitest.files[0]?.regions.find(
      (r) => r.symbol === "calculateTax",
    );
    expect(taxWithPitest?.state).toBe("weak-evidence");
    expect(taxWithPitest?.survivingMutants).toHaveLength(1);

    // Verify `codefog verify <File.java> --lines 4-9 --mutants`
    await fs.writeFile(
      runnerScript,
      [
        "import * as fs from 'node:fs';",
        "const src = fs.readFileSync('src/main/java/com/acme/order/OrderCalculator.java', 'utf8');",
        "const test = fs.readFileSync('src/test/java/com/acme/order/OrderCalculatorTest.java', 'utf8');",
        "if (src.includes('undefined')) {",
        "  console.error('OrderCalculator.java:5: error: incompatible types: cannot return undefined');",
        "  process.exit(1);",
        "}",
        "let fn;",
        "if (src.includes('cents <= 10')) fn = (c) => (c <= 10 ? 0 : Math.floor(c / 10));",
        "else if (src.includes('cents < 10')) fn = (c) => (c < 10 ? 0 : Math.floor(c / 10));",
        "else if (src.includes('cents > 10')) fn = (c) => (c > 10 ? 0 : Math.floor(c / 10));",
        "else fn = (_c) => 0;",
        "if (test.includes('calculateTax(0)') && fn(0) !== 0) process.exit(1);",
        "if (test.includes('calculateTax(10)') && fn(10) !== 0) process.exit(1);",
        "if (test.includes('calculateTax(200)') && fn(200) !== 20) process.exit(1);",
        "process.exit(0);",
      ].join("\n"),
      "utf8",
    );

    const vRes1 = await verifyTargetWithMutants({
      rootDir: tmpDir,
      targetFile: "src/main/java/com/acme/order/OrderCalculator.java",
      startLine: 4,
      endLine: 9,
      mutants: true,
      testCmd: "node run-java-check.mjs",
    });
    // Because test only checks `0` and `200` (missing boundary `10`), `cents <= 10` -> `cents < 10` survives!
    expect(vRes1.passed).toBe(false);

    // Strengthen test with boundary `calculateTax(10)` -> all mutants in lines 4-9 killed!
    await fs.writeFile(
      javaTestFile,
      javaTestSource.replace(
        "        assertEquals(0, calc.calculateTax(0));",
        "        assertEquals(0, calc.calculateTax(0));\n        assertEquals(0, calc.calculateTax(10));",
      ),
      "utf8",
    );

    const vRes2 = await verifyTargetWithMutants({
      rootDir: tmpDir,
      targetFile: "src/main/java/com/acme/order/OrderCalculator.java",
      startLine: 4,
      endLine: 9,
      mutants: true,
      testCmd: "node run-java-check.mjs",
    });
    expect(vRes2.passed).toBe(true);
    expect(vRes2.killedMutants).toBeGreaterThanOrEqual(2);
  });

  it("aggregates a 4-language polyglot repository (TypeScript + Go + Rust + Java) into a single unified CodefogReport via repeatable --coverage flags", async () => {
    // 1. TypeScript module (`src/web/auth.ts` + `tests/auth.test.ts`)
    await fs.mkdir(path.join(tmpDir, "src", "web"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "tests"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "src", "web", "auth.ts"),
      "export function verifyJwt(tok: string): boolean {\n  return tok.startsWith('jwt_');\n}\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(tmpDir, "tests", "auth.test.ts"),
      "import { it, expect } from 'vitest';\nimport { verifyJwt } from '../src/web/auth.js';\nit('checks jwt', () => {\n  expect(verifyJwt('jwt_123')).toBe(true);\n});\n",
      "utf8",
    );

    // 2. Go module (`internal/gateway/router.go` + `internal/gateway/router_test.go`)
    await fs.mkdir(path.join(tmpDir, "internal", "gateway"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "go.mod"), "module github.com/acme/poly\n\ngo 1.22\n", "utf8");
    await fs.writeFile(
      path.join(tmpDir, "internal", "gateway", "router.go"),
      'package gateway\n\nfunc RoutePort(env string) int {\n  if env == "prod" {\n    return 443\n  }\n  return 8080\n}\n',
      "utf8",
    );
    await fs.writeFile(
      path.join(tmpDir, "internal", "gateway", "router_test.go"),
      'package gateway\nimport "testing"\nfunc TestRoutePort(t *testing.T) {\n  if got := RoutePort("prod"); got != 443 { t.Fatal(got) }\n}\n',
      "utf8",
    );

    // 3. Rust module (`crates/crypto/src/hash.rs` with inline `#[cfg(test)]`)
    await fs.mkdir(path.join(tmpDir, "crates", "crypto", "src"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "crates", "crypto", "src", "hash.rs"),
      "pub fn digest_len(alg: &str) -> usize {\n    if alg == \"sha256\" { return 32; }\n    64\n}\n#[cfg(test)]\nmod tests {\n    use super::*;\n    #[test]\n    fn test_digest_len() {\n        assert_eq!(digest_len(\"sha256\"), 32);\n    }\n}\n",
      "utf8",
    );

    // 4. Java module (`services/ledger/src/main/java/com/acme/Ledger.java` + `services/ledger/src/test/java/com/acme/LedgerTest.java`)
    await fs.mkdir(
      path.join(tmpDir, "services", "ledger", "src", "main", "java", "com", "acme"),
      { recursive: true },
    );
    await fs.mkdir(
      path.join(tmpDir, "services", "ledger", "src", "test", "java", "com", "acme"),
      { recursive: true },
    );
    await fs.writeFile(
      path.join(tmpDir, "services", "ledger", "src", "main", "java", "com", "acme", "Ledger.java"),
      "package com.acme;\npublic class Ledger {\n  public int balance(int init) {\n    return init + 10;\n  }\n}\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(
        tmpDir,
        "services",
        "ledger",
        "src",
        "test",
        "java",
        "com",
        "acme",
        "LedgerTest.java",
      ),
      "package com.acme;\nimport org.junit.jupiter.api.Test;\nimport static org.junit.jupiter.api.Assertions.*;\npublic class LedgerTest {\n  @Test\n  public void testBalance() {\n    Ledger l = new Ledger();\n    assertEquals(20, l.balance(10));\n  }\n}\n",
      "utf8",
    );

    // Coverage files for all 4 languages:
    // - LCOV (covering TypeScript + Rust)
    await fs.mkdir(path.join(tmpDir, "coverage"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "coverage", "lcov.info"),
      [
        "TN:",
        `SF:${path.join(tmpDir, "src", "web", "auth.ts")}`,
        "DA:1,1",
        "DA:2,1",
        "end_of_record",
        "TN:",
        `SF:${path.join(tmpDir, "crates", "crypto", "src", "hash.rs")}`,
        "DA:1,1",
        "DA:2,1",
        "DA:3,1",
        "end_of_record",
      ].join("\n"),
      "utf8",
    );

    // - Go coverprofile (`coverage.out`)
    await fs.writeFile(
      path.join(tmpDir, "coverage.out"),
      [
        "mode: set",
        "github.com/acme/poly/internal/gateway/router.go:3.29,4.19 1 1",
        "github.com/acme/poly/internal/gateway/router.go:4.19,6.4 1 1",
        "github.com/acme/poly/internal/gateway/router.go:7.3,7.14 1 1",
      ].join("\n"),
      "utf8",
    );

    // - JaCoCo XML (`jacoco.xml`)
    await fs.writeFile(
      path.join(tmpDir, "jacoco.xml"),
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<report name="poly">',
        '  <package name="com/acme">',
        '    <sourcefile name="Ledger.java">',
        '      <line nr="4" mi="0" ci="2" mb="0" cb="0"/>',
        "    </sourcefile>",
        "  </package>",
        "</report>",
      ].join("\n"),
      "utf8",
    );

    await git(tmpDir, ["add", "."]);
    await git(tmpDir, ["commit", "-m", "feat: add 4-language polyglot repo"]);

    let stdout = "";
    const code = await runCli(
      [
        "--root",
        tmpDir,
        "--coverage",
        "coverage/lcov.info,coverage.out",
        "--coverage",
        "jacoco.xml",
        "--json",
        "--fail-on",
        "none",
      ],
      {
        stdout: (s) => {
          stdout += s;
        },
        stderr: () => {},
      },
    );

    expect(code).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.summary.totalFiles).toBe(4);
    const paths = report.files.map((f: { path: string }) => f.path).sort();
    expect(paths).toEqual([
      "crates/crypto/src/hash.rs",
      "internal/gateway/router.go",
      "services/ledger/src/main/java/com/acme/Ledger.java",
      "src/web/auth.ts",
    ]);
    for (const f of report.files) {
      expect(f.regions[0].assertionsOnOutcome).toBeGreaterThanOrEqual(1);
      expect(f.regions[0].pseudoTested).toBe(false);
    }
  });
});
