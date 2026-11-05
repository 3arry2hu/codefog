import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { analyzeRepository } from "../src/analyzer.js";
import { runCli } from "../src/cli.js";

describe("Ticket 27: Executable docs — Rust code block execution evidence (--run-docs)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefog-t27-rust-"));
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "coverage"), { recursive: true });

    await fs.writeFile(
      path.join(tmpDir, "Cargo.toml"),
      [
        "[package]",
        'name = "acme-fee"',
        'version = "0.1.0"',
        'edition = "2021"',
      ].join("\n") + "\n",
      "utf8",
    );

    await fs.writeFile(
      path.join(tmpDir, "src", "lib.rs"),
      [
        "pub fn calculate_fee(amount: i64) -> i64 {",
        "    (amount * 3) / 100",
        "}",
        "",
        "pub fn parse_fee(raw: &str) -> Result<i64, &'static str> {",
        "    raw.parse::<i64>().map_err(|_| \"invalid fee\")",
        "}",
      ].join("\n") + "\n",
      "utf8",
    );

    await fs.writeFile(
      path.join(tmpDir, "coverage", "lcov.info"),
      [
        "TN:",
        `SF:${path.join(tmpDir, "src", "lib.rs")}`,
        "DA:1,1",
        "DA:2,1",
        "DA:5,1",
        "DA:6,1",
        "end_of_record",
      ].join("\n") + "\n",
      "utf8",
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("wraps rust code blocks without fn main (rustdoc style) and imports the local crate: marks passing assert_eq!(calculate_fee(100), 3) as verified and println!(\"{}\", calculate_fee(100)) as weak-evidence", async () => {
    await fs.writeFile(
      path.join(tmpDir, "README.md"),
      [
        "# Acme Fee Crate",
        "",
        "```rust",
        "assert_eq!(calculate_fee(100), 3);",
        "```",
        "",
        "```rust",
        'println!("{}", calculate_fee(100));',
        "```",
      ].join("\n") + "\n",
      "utf8",
    );

    // Without --run-docs, both rust code blocks are recorded as fog
    const reportWithoutRun = await analyzeRepository({
      rootDir: tmpDir,
      docs: true,
    });
    const unrunBlocks = (reportWithoutRun.docClaims ?? []).filter(
      (c) => c.kind === "code-block",
    );
    expect(unrunBlocks.length).toBe(2);
    expect(unrunBlocks[0]?.state).toBe("fog");
    expect(unrunBlocks[1]?.state).toBe("fog");
    expect(reportWithoutRun.summary.docTrustScore).toBe(0);

    // With --run-docs, blocks are wrapped in fn main() with crate imported and executed
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
      c.rawText.includes("assert_eq!(calculate_fee(100), 3)"),
    );
    const printlnBlock = codeClaims.find((c) =>
      c.rawText.includes('println!("{}", calculate_fee(100))'),
    );

    expect(assertedBlock?.state).toBe("verified");
    expect(printlnBlock?.state).toBe("weak-evidence");

    // 1 verified (+1.0) + 1 weak-evidence (+0.4) = 1.4 / 2 = 0.7 -> 70
    expect(report.summary.docTrustScore).toBe(70);
    expect(report.docTrustScore).toBe(70);
    expect(report.findings.filter((f) => f.subjectType === "doc")).toEqual([]);
  });

  it("reuses Rust adapter Outcome Assertion rules (assert_ne!, matches! -> verified; .unwrap() / is_ok() / println! -> weak-evidence) and marks compile or assertion failures as fog-returned with Finding diagnostics", async () => {
    await fs.writeFile(
      path.join(tmpDir, "README.md"),
      [
        "# Rust Outcome Assertions & Failures",
        "",
        "```rust",
        "assert_ne!(calculate_fee(100), 0);",
        'assert!(matches!(parse_fee("100"), Ok(100)));',
        "```",
        "",
        "```rust",
        'let parsed = parse_fee("100").unwrap();',
        'assert!(parse_fee("100").is_ok());',
        'println!("{}", parsed);',
        "```",
        "",
        "```rust",
        "let broken: i64 = non_existent_helper(100);",
        "assert_eq!(broken, 3);",
        "```",
        "",
        "```rust",
        "assert_eq!(calculate_fee(100), 999);",
        "```",
      ].join("\n") + "\n",
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
    expect(codeClaims.length).toBe(4);

    // Block 1: `assert_ne!` and `matches!` -> verified
    expect(codeClaims[0]?.state).toBe("verified");

    // Block 2: `.unwrap()`, `assert!(...is_ok())`, `println!` -> weak-evidence (0 Outcome Assertions)
    expect(codeClaims[1]?.state).toBe("weak-evidence");

    // Block 3: Compile failure -> fog-returned
    expect(codeClaims[2]?.state).toBe("fog-returned");
    expect(codeClaims[2]?.executionOutput).toMatch(/non_existent_helper|error/i);

    // Block 4: Runtime assertion failure -> fog-returned
    expect(codeClaims[3]?.state).toBe("fog-returned");
    expect(codeClaims[3]?.executionOutput).toMatch(/999|panicked|assertion/i);

    // 1 verified (+1.0) + 1 weak-evidence (+0.4) + 2 fog-returned (2 * -0.5 = -1.0) = 0.4 / 4 = 0.10 -> 10
    expect(report.summary.docTrustScore).toBe(10);
    expect(report.docTrustScore).toBe(10);

    const docFindings = report.findings.filter((f) => f.subjectType === "doc");
    expect(docFindings.length).toBe(2);

    const compileFinding = docFindings.find(
      (f) => f.location.startLine === codeClaims[2]?.startLine,
    );
    const runtimeFinding = docFindings.find(
      (f) => f.location.startLine === codeClaims[3]?.startLine,
    );

    expect(compileFinding?.state).toBe("fog-returned");
    expect(compileFinding?.tags).toContain("doc-fog-returned");
    expect(compileFinding?.reason).toMatch(/non_existent_helper|error/i);

    expect(runtimeFinding?.state).toBe("fog-returned");
    expect(runtimeFinding?.tags).toContain("doc-fog-returned");
    expect(runtimeFinding?.reason).toMatch(/999|panicked|assertion/i);
  });

  it("supports explicit fn main(), ignores non-rust or shell code blocks, and gates on doc-fog-returned via runCli", async () => {
    const sideEffectFile = path.join(tmpDir, "shell-side-effect.txt");

    await fs.writeFile(
      path.join(tmpDir, "README.md"),
      [
        "# CLI & Explicit Main",
        "",
        "```bash",
        `echo "pwned" > "${sideEffectFile.replace(/\\/g, "/")}"`,
        "```",
        "",
        "```rs",
        "compile_error!(\"rs tag should not be executed, only rust tag\");",
        "```",
        "",
        "<!-- codefog-ignore-next -->",
        "```rust",
        "compile_error!(\"ignored block\");",
        "```",
        "",
        "```rust",
        "use acme_fee::calculate_fee;",
        "",
        "fn main() {",
        "    assert_eq!(calculate_fee(200), 6);",
        "}",
        "```",
        "",
        "```rust",
        "assert_eq!(calculate_fee(100), 999);",
        "```",
      ].join("\n") + "\n",
      "utf8",
    );

    let stdout1 = "";
    const exitCode1 = await runCli(
      [
        "--root",
        tmpDir,
        "--docs",
        "--run-docs",
        "--json",
        "--fail-on",
        "doc-returned",
      ],
      {
        stdout: (s) => {
          stdout1 += s;
        },
        stderr: () => {},
      },
    );

    expect(exitCode1).toBe(1);

    let sideEffectExists = false;
    try {
      await fs.access(sideEffectFile);
      sideEffectExists = true;
    } catch {
      sideEffectExists = false;
    }
    expect(sideEffectExists).toBe(false);

    const parsed1 = JSON.parse(stdout1);
    expect(parsed1.docClaims.length).toBe(2);
    expect(parsed1.docClaims[0].state).toBe("verified");
    expect(parsed1.docClaims[1].state).toBe("fog-returned");
    // 1 verified (+1.0) + 1 fog-returned (-0.5) = 0.5 / 2 = 0.25 -> 25
    expect(parsed1.summary.docTrustScore).toBe(25);

    // Fix the failing block and re-run CLI -> exitCode 0 and Doc Trust Score 100
    await fs.writeFile(
      path.join(tmpDir, "README.md"),
      [
        "# CLI & Explicit Main",
        "",
        "```rust",
        "use acme_fee::calculate_fee;",
        "",
        "fn main() {",
        "    assert_eq!(calculate_fee(200), 6);",
        "}",
        "```",
        "",
        "```rust",
        "assert_eq!(calculate_fee(100), 3);",
        "```",
      ].join("\n") + "\n",
      "utf8",
    );

    let stdout2 = "";
    const exitCode2 = await runCli(
      [
        "--root",
        tmpDir,
        "--docs",
        "--run-docs",
        "--json",
        "--fail-on",
        "doc-returned",
      ],
      {
        stdout: (s) => {
          stdout2 += s;
        },
        stderr: () => {},
      },
    );

    expect(exitCode2).toBe(0);
    const parsed2 = JSON.parse(stdout2);
    expect(parsed2.docClaims.length).toBe(2);
    expect(parsed2.docClaims[0].state).toBe("verified");
    expect(parsed2.docClaims[1].state).toBe("verified");
    expect(parsed2.summary.docTrustScore).toBe(100);
  });
});
