import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { analyzeRepository } from "../src/analyzer.js";
import { runCli } from "../src/cli.js";

const execFileAsync = promisify(execFile);

describe("Ticket 28: Executable docs — Java code block execution evidence (--run-docs)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefog-t28-java-"));
    const javaSrcDir = path.join(tmpDir, "src", "main", "java", "com", "acme", "order");
    const targetClassesDir = path.join(tmpDir, "target", "classes");
    const jacocoDir = path.join(tmpDir, "target", "site", "jacoco");

    await fs.mkdir(javaSrcDir, { recursive: true });
    await fs.mkdir(targetClassesDir, { recursive: true });
    await fs.mkdir(jacocoDir, { recursive: true });

    const javaSrcFile = path.join(javaSrcDir, "OrderCalculator.java");
    await fs.writeFile(
      javaSrcFile,
      [
        "package com.acme.order;",
        "",
        "public class OrderCalculator {",
        "    public int calculateTax(int cents) {",
        "        if (cents <= 10) {",
        "            return 0;",
        "        }",
        "        return cents / 10;",
        "    }",
        "}",
      ].join("\n"),
      "utf8",
    );

    await execFileAsync("/usr/bin/javac", ["-d", targetClassesDir, javaSrcFile], {
      cwd: tmpDir,
    });

    await fs.writeFile(
      path.join(jacocoDir, "jacoco.xml"),
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<report name="acme-order">',
        '  <package name="com/acme/order">',
        '    <sourcefile name="OrderCalculator.java">',
        '      <line nr="5" mi="0" ci="3" mb="0" cb="2"/>',
        '      <line nr="6" mi="0" ci="1" mb="0" cb="0"/>',
        '      <line nr="8" mi="0" ci="2" mb="0" cb="0"/>',
        "    </sourcefile>",
        "  </package>",
        "</report>",
      ].join("\n"),
      "utf8",
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("wraps classless Java code blocks in a main class against target/classes: marks passing explicit value-comparison throw as verified and System.out.println-only as weak-evidence", async () => {
    await fs.writeFile(
      path.join(tmpDir, "README.md"),
      [
        "# OrderCalculator Java Examples",
        "",
        "```java",
        "import com.acme.order.OrderCalculator;",
        "",
        "OrderCalculator calc = new OrderCalculator();",
        "int tax = calc.calculateTax(200);",
        "if (tax != 20) {",
        '    throw new AssertionError("Expected 20, got " + tax);',
        "}",
        "```",
        "",
        "```java",
        "import com.acme.order.OrderCalculator;",
        "",
        "OrderCalculator calc = new OrderCalculator();",
        "System.out.println(calc.calculateTax(200)); // => 20",
        "```",
      ].join("\n"),
      "utf8",
    );

    // Without --run-docs, Java code blocks are fog
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
    expect(reportWithoutRun.summary.docTrustScore).toBe(0);

    // With --run-docs, the first block is verified and the second is weak-evidence
    const report = await analyzeRepository({
      rootDir: tmpDir,
      docs: true,
      runDocs: true,
    });

    const codeClaims = (report.docClaims ?? []).filter(
      (c) => c.kind === "code-block",
    );
    expect(codeClaims.length).toBe(2);

    const assertedBlock = codeClaims.find((c) =>
      c.rawText.includes("throw new AssertionError"),
    );
    const printlnBlock = codeClaims.find((c) =>
      c.rawText.includes("System.out.println"),
    );

    expect(assertedBlock?.state).toBe("verified");
    expect(printlnBlock?.state).toBe("weak-evidence");

    // 1 verified (+1.0) + 1 weak-evidence (+0.4) = 1.4 / 2 = 0.7 -> 70
    expect(report.summary.docTrustScore).toBe(70);
    expect(report.docTrustScore).toBe(70);
    expect(report.findings.filter((f) => f.subjectType === "doc")).toEqual([]);
  });

  it("marks Java code blocks with compilation errors or runtime assertion failures as fog-returned with failure summary in Finding", async () => {
    await fs.writeFile(
      path.join(tmpDir, "README.md"),
      [
        "# Broken Java Examples",
        "",
        "```java",
        "import com.acme.order.OrderCalculator;",
        "",
        "OrderCalculator calc = new OrderCalculator();",
        "System.out.println(calc.nonExistentMethod(200));",
        "```",
        "",
        "```java",
        "import com.acme.order.OrderCalculator;",
        "",
        "OrderCalculator calc = new OrderCalculator();",
        "if (calc.calculateTax(200) != 999) {",
        '    throw new IllegalStateException("Expected 999");',
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

    const codeClaims = (report.docClaims ?? []).filter(
      (c) => c.kind === "code-block",
    );
    expect(codeClaims.length).toBe(2);
    expect(codeClaims[0]?.state).toBe("fog-returned");
    expect(codeClaims[1]?.state).toBe("fog-returned");

    expect(codeClaims[0]?.executionOutput).toMatch(/cannot find symbol|nonExistentMethod/);
    expect(codeClaims[1]?.executionOutput).toMatch(/IllegalStateException|Expected 999/);

    expect(report.summary.docTrustScore).toBe(0);
    expect(report.docTrustScore).toBe(0);

    const docFindings = report.findings.filter((f) => f.subjectType === "doc");
    expect(docFindings.length).toBe(2);

    const compileFinding = docFindings.find(
      (f) => f.location.startLine === codeClaims[0]?.startLine,
    );
    const runtimeFinding = docFindings.find(
      (f) => f.location.startLine === codeClaims[1]?.startLine,
    );

    expect(compileFinding?.state).toBe("fog-returned");
    expect(compileFinding?.tags).toContain("doc-fog-returned");
    expect(compileFinding?.reason).toMatch(/cannot find symbol|nonExistentMethod/);

    expect(runtimeFinding?.state).toBe("fog-returned");
    expect(runtimeFinding?.tags).toContain("doc-fog-returned");
    expect(runtimeFinding?.reason).toMatch(/IllegalStateException|Expected 999/);
  });

  it("supports Gradle build/classes/java/main classpath, JUnit assertEquals & AssertJ assertThat(x).isEqualTo(y) Outcome Assertions vs Liveness Checks, and runCli --run-docs", async () => {
    // Replace Maven target/classes with Gradle build/classes/java/main
    await fs.rm(path.join(tmpDir, "target", "classes"), {
      recursive: true,
      force: true,
    });
    const gradleClassesDir = path.join(
      tmpDir,
      "build",
      "classes",
      "java",
      "main",
    );
    await fs.mkdir(gradleClassesDir, { recursive: true });
    const javaSrcFile = path.join(
      tmpDir,
      "src",
      "main",
      "java",
      "com",
      "acme",
      "order",
      "OrderCalculator.java",
    );
    await execFileAsync("/usr/bin/javac", ["-d", gradleClassesDir, javaSrcFile], {
      cwd: tmpDir,
    });

    const sideEffectFile = path.join(tmpDir, "shell-side-effect.txt");
    await fs.writeFile(
      path.join(tmpDir, "README.md"),
      [
        "# Gradle Classpath & Assertion Styles",
        "",
        "```bash",
        `echo "pwned" > "${sideEffectFile.replace(/\\/g, "/")}"`,
        "```",
        "",
        "```java",
        "import static org.junit.jupiter.api.Assertions.assertEquals;",
        "",
        "OrderCalculator calc = new OrderCalculator();",
        "assertEquals(20, calc.calculateTax(200));",
        "```",
        "",
        "```java",
        "import static org.assertj.core.api.Assertions.assertThat;",
        "",
        "OrderCalculator calc = new OrderCalculator();",
        "assertThat(calc.calculateTax(200)).isEqualTo(20);",
        "```",
        "",
        "```java",
        "OrderCalculator calc = new OrderCalculator();",
        "assertNotNull(calc);",
        "```",
      ].join("\n"),
      "utf8",
    );

    let stdoutBuf = "";
    const exitCode = await runCli(
      ["--root", tmpDir, "--docs", "--run-docs", "--json", "--fail-on", "none"],
      {
        stdout: (s) => {
          stdoutBuf += s;
        },
        stderr: () => {},
      },
    );

    expect(exitCode).toBe(0);

    let sideEffectExists = false;
    try {
      await fs.access(sideEffectFile);
      sideEffectExists = true;
    } catch {
      sideEffectExists = false;
    }
    expect(sideEffectExists).toBe(false);

    const parsed = JSON.parse(stdoutBuf);
    const claims = parsed.docClaims.filter(
      (c: { kind: string }) => c.kind === "code-block",
    );
    expect(claims.length).toBe(3);
    expect(claims[0].state).toBe("verified");
    expect(claims[1].state).toBe("verified");
    // assertNotNull is a Liveness Check -> weak-evidence
    expect(claims[2].state).toBe("weak-evidence");

    // 2 verified (2.0) + 1 weak-evidence (0.4) = 2.4 / 3 = 0.8 -> 80
    expect(parsed.summary.docTrustScore).toBe(80);
    expect(parsed.docTrustScore).toBe(80);
  });
});
