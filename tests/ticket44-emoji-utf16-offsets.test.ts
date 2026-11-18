import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { analyzeRepository } from "../src/analyzer.js";
import { runCli } from "../src/cli.js";
import {
  goLanguageAdapter,
  javaLanguageAdapter,
  rustLanguageAdapter,
  stripCommentsAndMaskStrings,
} from "../src/polyglot.js";

describe("Ticket 44: non-BMP UTF-16 surrogate pairs (emojis) in comments and literals do not shift or drop polyglot functions", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefog-t44-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("recognizes Go Foo at exact line numbers with Trust 100 and --fail-on any-fog exit 0 across CJK, 1-emoji, and multi-emoji comments", async () => {
    for (const [sub, comment] of [
      ["cjk", "普通中文注释"],
      ["one-emoji", "🚀"],
      ["two-emoji", "🚀🚀"],
      ["zwj-emoji", "👨‍👩‍👧‍👦 𠮷 🔥🔥🔥"],
    ] as const) {
      const repoDir = path.join(tmpDir, sub);
      await fs.mkdir(repoDir, { recursive: true });
      await fs.writeFile(path.join(repoDir, "go.mod"), "module demo\n\ngo 1.21\n", "utf8");
      await fs.writeFile(
        path.join(repoDir, "foo.go"),
        [
          "package demo",
          "",
          `// ${comment}`,
          "func Foo(x int) int {",
          "\treturn x + 1",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );
      await fs.writeFile(
        path.join(repoDir, "foo_test.go"),
        [
          "package demo",
          'import "testing"',
          "// 🧪🎉",
          "func TestFoo(t *testing.T) {",
          "\tif got := Foo(1); got != 2 {",
          '\t\tt.Fatalf("got %d", got)',
          "\t}",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );
      await fs.writeFile(
        path.join(repoDir, "coverage.out"),
        ["mode: set", "demo/foo.go:4.21,6.2 1 1", ""].join("\n"),
        "utf8",
      );

      const report = await analyzeRepository({
        rootDir: repoDir,
        coveragePath: "coverage.out",
      });
      expect(report.summary.trustScore).toBe(100);
      expect(report.files[0]?.regions).toHaveLength(1);
      expect(report.files[0]?.regions[0]).toMatchObject({
        symbol: "Foo",
        startLine: 4,
        endLine: 6,
        state: "verified",
        assertionsOnOutcome: 1,
      });

      const exitCode = await runCli(
        ["--root", repoDir, "--coverage", "coverage.out", "--fail-on", "any-fog"],
        { stdout: () => {}, stderr: () => {} },
      );
      expect(exitCode).toBe(0);
    }
  });

  it("preserves Rust unexported fn spans, #[cfg(test)] filtering, and outcome assertions after multi-emoji comments and Rust lifetimes", async () => {
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "coverage"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "Cargo.toml"),
      '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n',
      "utf8",
    );
    await fs.writeFile(
      path.join(tmpDir, "src", "lib.rs"),
      [
        "// 🚀🚀🦀🦀",
        "fn helper<'a>(label: &'a str, x: i32) -> i32 {",
        "    let emoji_rune = '🚀';",
        "    if label.is_empty() || emoji_rune == '\\u{7b}' {",
        "        return 0;",
        "    }",
        "    x + 1",
        "}",
        "",
        "#[cfg(test)]",
        "mod tests {",
        "    use super::*;",
        "    // 🎯🎯",
        "    #[test]",
        "    fn checks_helper() {",
        '        assert_eq!(helper("ok", 4), 5);',
        '        assert_eq!(helper("", 4), 0);',
        "    }",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(tmpDir, "coverage", "lcov.info"),
      [
        "TN:",
        "SF:src/lib.rs",
        "DA:2,2",
        "DA:3,2",
        "DA:4,2",
        "DA:5,1",
        "DA:7,1",
        "DA:15,1",
        "DA:16,1",
        "DA:17,1",
        "LF:8",
        "LH:8",
        "end_of_record",
      ].join("\n"),
      "utf8",
    );

    const report = await analyzeRepository({ rootDir: tmpDir });
    expect(report.summary.trustScore).toBe(100);
    expect(report.files[0]?.totalLoc).toBe(5);
    expect(report.files[0]?.regions).toHaveLength(1);
    expect(report.files[0]?.regions[0]).toMatchObject({
      symbol: "helper",
      startLine: 2,
      endLine: 8,
      state: "verified",
    });
  });

  it("preserves Java package-private method spans and JUnit outcome assertions after multi-emoji block comments and escaped char literals", async () => {
    await fs.mkdir(path.join(tmpDir, "src", "main", "java", "demo"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "src", "test", "java", "demo"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "target", "site", "jacoco"), { recursive: true });

    await fs.writeFile(
      path.join(tmpDir, "src", "main", "java", "demo", "Calc.java"),
      [
        "package demo;",
        "public class Calc {",
        "  /* 🚀🚀🚀🚀 */",
        "  int addOne(int x) {",
        "    char openBrace = '\\u007b';",
        "    return openBrace == '{' ? x + 1 : x;",
        "  }",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(tmpDir, "src", "test", "java", "demo", "CalcTest.java"),
      [
        "package demo;",
        "import static org.junit.jupiter.api.Assertions.assertEquals;",
        "import org.junit.jupiter.api.Test;",
        "class CalcTest {",
        "  // 🧪🧪🧪",
        "  @Test",
        "  void addsOne() {",
        "    assertEquals(2, new Calc().addOne(1));",
        "  }",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(tmpDir, "target", "site", "jacoco", "jacoco.xml"),
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<report name="demo">',
        '  <package name="demo">',
        '    <sourcefile name="Calc.java">',
        '      <line nr="5" mi="0" ci="1" mb="0" cb="0"/>',
        '      <line nr="6" mi="0" ci="2" mb="0" cb="0"/>',
        "    </sourcefile>",
        "  </package>",
        "</report>",
      ].join("\n"),
      "utf8",
    );

    const report = await analyzeRepository({ rootDir: tmpDir });
    expect(report.summary.trustScore).toBe(100);
    expect(report.files[0]?.regions[0]).toMatchObject({
      symbol: "addOne",
      startLine: 4,
      endLine: 7,
      state: "verified",
      assertionsOnOutcome: 1,
    });
  });

  it("generates syntactically aligned Go, Rust, and Java candidate mutations when emojis precede the function", () => {
    const goSource = [
      "package demo",
      "// 🚀🚀",
      "func Clamp(x int) int {",
      "\tr := '🚀'",
      "\tif x <= 0 && r != '\\u007b' {",
      "\t\treturn 0",
      "\t}",
      "\treturn x",
      "}",
      "",
    ].join("\n");
    const goMuts = goLanguageAdapter.generateCandidateMutations(goSource);
    expect(goMuts.length).toBeGreaterThan(0);
    for (const m of goMuts) {
      expect(m.mutatedSource).toContain("func Clamp(x int) int {");
      expect(m.line).toBeGreaterThanOrEqual(3);
    }

    const rustSource = [
      "// 🚀🚀🚀",
      "fn clamp(x: i32) -> i32 {",
      "    if x <= 0 {",
      "        return 0;",
      "    }",
      "    x",
      "}",
      "",
    ].join("\n");
    const rustMuts = rustLanguageAdapter.generateCandidateMutations(rustSource);
    expect(rustMuts.length).toBeGreaterThan(0);
    for (const m of rustMuts) {
      expect(m.mutatedSource).toContain("fn clamp(x: i32) -> i32 {");
    }

    const javaSource = [
      "class Clamp {",
      "  // 🚀🚀🚀",
      "  int clamp(int x) {",
      "    if (x <= 0) {",
      "      return 0;",
      "    }",
      "    return x;",
      "  }",
      "}",
      "",
    ].join("\n");
    const javaMuts = javaLanguageAdapter.generateCandidateMutations(javaSource);
    expect(javaMuts.length).toBeGreaterThan(0);
    for (const m of javaMuts) {
      expect(m.mutatedSource).toContain("int clamp(int x) {");
    }

    const mixedUnicode = "package p\n// 🚀👨‍👩‍👧‍👦𠮷\nconst s = \"🎉/*not comment*/\"\nconst r = '🚀'\nfunc Ok() {}\n";
    const { noComments, masked } = stripCommentsAndMaskStrings(mixedUnicode);
    expect(noComments.length).toBe(mixedUnicode.length);
    expect(masked.length).toBe(mixedUnicode.length);
    for (let idx = 0; idx < mixedUnicode.length; idx++) {
      expect(noComments[idx] === "\n").toBe(mixedUnicode[idx] === "\n");
      expect(masked[idx] === "\n").toBe(mixedUnicode[idx] === "\n");
    }
  });
});
