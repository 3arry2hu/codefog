import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { analyzeRepository } from "../src/analyzer.js";
import { runCli } from "../src/cli.js";

describe("Ticket 22: Executable docs — TS/JS code block execution evidence (--run-docs)", { timeout: 60_000 }, () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefog-t22-"));
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "docs"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "coverage"), { recursive: true });

    await fs.writeFile(
      path.join(tmpDir, "package.json"),
      JSON.stringify(
        {
          name: "acme-fee-lib",
          version: "1.0.0",
          type: "module",
        },
        null,
        2,
      ),
      "utf8",
    );

    await fs.writeFile(
      path.join(tmpDir, "src", "fee.ts"),
      [
        "export function calculateFee(amount: number): number {",
        "  return Math.round(amount * 0.03);",
        "}",
      ].join("\n"),
      "utf8",
    );

    await fs.writeFile(
      path.join(tmpDir, "src", "internal.ts"),
      [
        "export function internalOnlyHelper(): number {",
        "  return 42;",
        "}",
      ].join("\n"),
      "utf8",
    );

    await fs.writeFile(
      path.join(tmpDir, "src", "index.ts"),
      'export { calculateFee } from "./fee.js";\n',
      "utf8",
    );

    await fs.writeFile(
      path.join(tmpDir, "coverage", "lcov.info"),
      [
        "TN:",
        "SF:src/fee.ts",
        "FN:1,calculateFee",
        "FNF:1",
        "FNH:1",
        "FNDA:1,calculateFee",
        "DA:1,1",
        "DA:2,1",
        "LF:2",
        "LH:2",
        "end_of_record",
      ].join("\n"),
      "utf8",
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("marks all runnable TS/JS code blocks as fog when --run-docs is not enabled, respects <!-- codefog-ignore-next -->, and matches hand-calculated Doc Trust Score", async () => {
    await fs.writeFile(
      path.join(tmpDir, "docs", "guide.md"),
      "# Guide\n",
      "utf8",
    );

    await fs.writeFile(
      path.join(tmpDir, "README.md"),
      [
        "# Fee Library",
        "",
        "See [Guide](docs/guide.md) for details.",
        "",
        "```ts",
        'import assert from "node:assert";',
        'import { calculateFee } from "acme-fee-lib";',
        "assert.equal(calculateFee(100), 3);",
        "```",
        "",
        "```js",
        'import { calculateFee } from "acme-fee-lib";',
        "console.log(calculateFee(100)); // => 3",
        "```",
        "",
        "<!-- codefog-ignore-next -->",
        "```ts",
        "throw new Error('ignored block');",
        "```",
      ].join("\n"),
      "utf8",
    );

    const report = await analyzeRepository({ rootDir: tmpDir, docs: true });
    const claims = report.docClaims ?? [];
    const codeBlockClaims = claims.filter((c) => c.kind === "code-block");

    // 2 non-ignored TS/JS code blocks, both in fog state when --run-docs is false
    expect(codeBlockClaims.length).toBe(2);
    expect(codeBlockClaims[0]?.state).toBe("fog");
    expect(codeBlockClaims[1]?.state).toBe("fog");

    // Total claims: 1 verified link (docs/guide.md: +1.0) + 2 fog code blocks (0.0 each) = 3 claims
    // Doc Trust Score = round((1.0 / 3) * 100) = 33
    expect(report.summary.totalDocClaims).toBe(3);
    expect(report.summary.docClaimsByState?.verified).toBe(1);
    expect(report.summary.docClaimsByState?.fog).toBe(2);
    expect(report.summary.docTrustScore).toBe(33);
    expect(report.docTrustScore).toBe(33);
  });

  it("executes TS/JS code blocks under --run-docs: classifies passing assert.equal(calculateFee(100), 3) as verified and console.log(calculateFee(100)) // => 3 as weak-evidence", async () => {
    await fs.writeFile(
      path.join(tmpDir, "README.md"),
      [
        "# Usage Examples",
        "",
        "```ts",
        'import assert from "node:assert";',
        'import { calculateFee } from "acme-fee-lib";',
        "assert.equal(calculateFee(100), 3);",
        "```",
        "",
        "```javascript",
        'import { calculateFee } from "acme-fee-lib";',
        "console.log(calculateFee(100)) // => 3",
        "```",
      ].join("\n"),
      "utf8",
    );

    const report = await analyzeRepository({
      rootDir: tmpDir,
      docs: true,
      runDocs: true,
    });

    const claims = report.docClaims ?? [];
    const codeClaims = claims.filter((c) => c.kind === "code-block");
    expect(codeClaims.length).toBe(2);

    const assertedBlock = codeClaims.find((c) =>
      c.rawText.includes("assert.equal(calculateFee(100), 3)"),
    );
    const consoleBlock = codeClaims.find((c) =>
      c.rawText.includes("console.log(calculateFee(100)) // => 3"),
    );

    expect(assertedBlock?.state).toBe("verified");
    expect(consoleBlock?.state).toBe("weak-evidence");

    // 1 verified (+1.0) + 1 weak-evidence (+0.4) = 1.4 / 2 = 0.7 -> 70
    expect(report.summary.docTrustScore).toBe(70);
    expect(report.docTrustScore).toBe(70);
    expect(report.findings.filter((f) => f.subjectType === "doc")).toEqual([]);
  });

  it("marks code blocks with failing assertions, missing imports (no auto-injected assert or repo symbols), non-entry exports, or wrong package name as fog-returned", async () => {
    await fs.writeFile(
      path.join(tmpDir, "README.md"),
      [
        "# Broken Examples",
        "",
        "```typescript",
        'import assert from "node:assert";',
        'import { calculateFee } from "acme-fee-lib";',
        "assert.equal(calculateFee(100), 999);",
        "```",
        "",
        "```ts",
        'import { nonExistentSymbol } from "acme-fee-lib";',
        "console.log(nonExistentSymbol);",
        "```",
        "",
        "```ts",
        '// Missing import assert from "node:assert" must fail (no auto-injected assert)',
        'import { calculateFee } from "acme-fee-lib";',
        "assert.equal(calculateFee(100), 3);",
        "```",
        "",
        "```ts",
        "// Missing import of calculateFee must fail (no auto-import of repo symbols)",
        "console.log(calculateFee(100));",
        "```",
        "",
        "```ts",
        "// Importing from non-entry module via package root must fail (no re-export of non-entry modules)",
        'import { internalOnlyHelper } from "acme-fee-lib";',
        "console.log(internalOnlyHelper());",
        "```",
        "",
        "```ts",
        "// Hardcoded @barryzhu/codefog must not resolve when fixture package.json name is acme-fee-lib",
        'import { calculateFee } from "@barryzhu/codefog";',
        "console.log(calculateFee(100));",
        "```",
      ].join("\n"),
      "utf8",
    );

    const report = await analyzeRepository({
      rootDir: tmpDir,
      docs: true,
      runDocs: true,
    });

    const codeClaims = (report.docClaims ?? []).filter((c) => c.kind === "code-block");
    expect(codeClaims.length).toBe(6);
    for (const c of codeClaims) {
      expect(c.state).toBe("fog-returned");
    }

    expect(codeClaims[0]?.executionOutput).toMatch(/AssertionError|999/);
    expect(codeClaims[1]?.executionOutput).toMatch(/nonExistentSymbol/);

    const docFindings = report.findings.filter((f) => f.subjectType === "doc");
    expect(docFindings.length).toBe(6);

    const assertionFinding = docFindings.find(
      (f) => f.location.startLine === codeClaims[0]?.startLine,
    );
    const importFinding = docFindings.find(
      (f) => f.location.startLine === codeClaims[1]?.startLine,
    );

    expect(assertionFinding?.state).toBe("fog-returned");
    expect(assertionFinding?.tags).toContain("doc-fog-returned");
    expect(assertionFinding?.reason).toMatch(/AssertionError|999/);

    expect(importFinding?.state).toBe("fog-returned");
    expect(importFinding?.tags).toContain("doc-fog-returned");
    expect(importFinding?.reason).toMatch(/nonExistentSymbol/);
  });

  it("never executes bash/sh/shell/console code blocks containing npm publish under --run-docs (verified via side-effect file) and supports --run-docs via runCli", async () => {
    const sideEffectFile = path.join(tmpDir, "published-side-effect.txt");

    await fs.writeFile(
      path.join(tmpDir, "README.md"),
      [
        "# Release & Examples",
        "",
        "```bash",
        `echo "pwned" > "${sideEffectFile.replace(/\\/g, "/")}"`,
        "npm publish",
        "```",
        "",
        "```sh",
        `touch "${sideEffectFile.replace(/\\/g, "/")}"`,
        "```",
        "",
        "```console",
        `$ npm publish && echo "pwned" > "${sideEffectFile.replace(/\\/g, "/")}"`,
        "```",
        "",
        "```ts",
        'import assert from "node:assert";',
        'import { calculateFee } from "acme-fee-lib";',
        "assert.equal(calculateFee(100), 3);",
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

    // Side-effect file from bash/sh/console blocks must NOT exist
    let sideEffectExists = false;
    try {
      await fs.access(sideEffectFile);
      sideEffectExists = true;
    } catch {
      sideEffectExists = false;
    }
    expect(sideEffectExists).toBe(false);

    const parsed = JSON.parse(stdoutBuf);
    expect(parsed.docClaims.length).toBe(1);
    expect(parsed.docClaims[0].kind).toBe("code-block");
    expect(parsed.docClaims[0].state).toBe("verified");
    expect(parsed.summary.docTrustScore).toBe(100);
    expect(parsed.docTrustScore).toBe(100);
  });
});
