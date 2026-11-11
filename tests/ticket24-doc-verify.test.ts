import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runCli } from "../src/cli.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

describe("Ticket 24: Doc verification gate (codefog verify <doc.md>) & PR deleted doc claims", { timeout: 60_000 }, () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefog-t24-"));
    await git(tmpDir, ["init", "-b", "main"]);
    await git(tmpDir, ["config", "user.name", "Test Bot"]);
    await git(tmpDir, ["config", "user.email", "bot@example.com"]);
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("fails verify README.md when a fog-returned symbol claim (`calculateFee`, function still exists) is rewritten into vague text ('相关函数'), reporting the deleted claim and referent", async () => {
    const feeFile = path.join(tmpDir, "src", "fee.ts");
    const readmeFile = path.join(tmpDir, "README.md");

    // Commit A: synchronized code and README
    await fs.writeFile(
      feeFile,
      [
        "export function calculateFee(amount: number): number {",
        "  return amount * 0.02;",
        "}",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      readmeFile,
      [
        "# Billing",
        "",
        "调用 `calculateFee` 计算手续费。",
      ].join("\n"),
      "utf8",
    );
    await git(tmpDir, ["add", "."]);
    await git(tmpDir, ["commit", "-m", "feat: add calculateFee and README"]);

    // Commit B (HEAD): calculateFee runtime logic changes without updating README -> `calculateFee` claim enters fog-returned
    await fs.writeFile(
      feeFile,
      [
        "export function calculateFee(amount: number): number {",
        "  return Math.round(amount * 0.05 + 10);",
        "}",
      ].join("\n"),
      "utf8",
    );
    await git(tmpDir, ["add", "src/fee.ts"]);
    await git(tmpDir, ["commit", "-m", "feat: update calculateFee formula"]);

    // Working-tree edit: Agent rewrites `calculateFee` into vague prose "相关函数"
    await fs.writeFile(
      readmeFile,
      [
        "# Billing",
        "",
        "调用相关函数计算手续费。",
      ].join("\n"),
      "utf8",
    );

    let out = "";
    let err = "";
    const exitCode = await runCli(["verify", "README.md", "--root", tmpDir], {
      stdout: (s) => {
        out += s;
      },
      stderr: (s) => {
        err += s;
      },
    });

    expect(exitCode).toBe(1);
    expect(out).toBe("");
    expect(err).toContain("calculateFee");
    expect(err).toContain("src/fee.ts");
  });

  it("passes verify README.md when a fog-returned claim is replaced with renamed `computeFee`, fails when deleted after rename, and passes when deleting a claim whose referent was genuinely deleted", async () => {
    const feeFile = path.join(tmpDir, "src", "fee.ts");
    const readmeFile = path.join(tmpDir, "README.md");

    // Commit A: calculateFee and legacyDiscount exist in src/fee.ts; README references both
    await fs.writeFile(
      feeFile,
      [
        "export function calculateFee(amount: number): number {",
        "  return amount * 0.02;",
        "}",
        "",
        "export function legacyDiscount(amount: number): number {",
        "  return amount * 0.01;",
        "}",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      readmeFile,
      [
        "# Billing",
        "",
        "Call `calculateFee` to compute processing fees.",
        "",
        "Call `legacyDiscount` to compute legacy discounts.",
      ].join("\n"),
      "utf8",
    );
    await git(tmpDir, ["add", "."]);
    await git(tmpDir, ["commit", "-m", "feat: add calculateFee, legacyDiscount, and README"]);

    // Commit B (HEAD): rename calculateFee -> computeFee, and delete legacyDiscount completely
    await fs.writeFile(
      feeFile,
      [
        "export function computeFee(amount: number): number {",
        "  return amount * 0.02;",
        "}",
      ].join("\n"),
      "utf8",
    );
    await git(tmpDir, ["add", "src/fee.ts"]);
    await git(tmpDir, ["commit", "-m", "refactor: rename calculateFee to computeFee and remove legacyDiscount"]);

    // 1. Deleting the renamed symbol claim (`calculateFee`) without replacing it with `computeFee` must FAIL
    await fs.writeFile(
      readmeFile,
      [
        "# Billing",
        "",
        "Call the fee helper to compute processing fees.",
        "",
        "Legacy discounts are no longer supported.",
      ].join("\n"),
      "utf8",
    );
    let errDeleteRenamed = "";
    const exitDeleteRenamed = await runCli(["verify", "README.md", "--root", tmpDir], {
      stdout: () => {},
      stderr: (s) => {
        errDeleteRenamed += s;
      },
    });
    expect(exitDeleteRenamed).toBe(1);
    expect(errDeleteRenamed).toContain("calculateFee");
    expect(errDeleteRenamed).toContain("src/fee.ts");

    // 2. Replacing `calculateFee` with renamed `computeFee` AND deleting the claim for deleted `legacyDiscount` must PASS
    await fs.writeFile(
      readmeFile,
      [
        "# Billing",
        "",
        "Call `computeFee` to compute processing fees.",
        "",
        "Legacy discounts are no longer supported.",
      ].join("\n"),
      "utf8",
    );
    let outPass = "";
    let errPass = "";
    const exitPass = await runCli(["verify", "README.md", "--root", tmpDir], {
      stdout: (s) => {
        outPass += s;
      },
      stderr: (s) => {
        errPass += s;
      },
    });
    expect(exitPass).toBe(0);
    expect(errPass).toBe("");
    expect(outPass).toContain("VERIFIED");
  });

  it("fails verify README.md when referent source file src/fee.ts has uncommitted modifications relative to HEAD, and passes when --allow-source-change is provided", async () => {
    const feeFile = path.join(tmpDir, "src", "fee.ts");
    const readmeFile = path.join(tmpDir, "README.md");

    // Commit A: synchronized code and README
    await fs.writeFile(
      feeFile,
      [
        "export function calculateFee(amount: number): number {",
        "  return amount * 0.02;",
        "}",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      readmeFile,
      [
        "# Billing",
        "",
        "Call `calculateFee` to compute the 2% fee.",
      ].join("\n"),
      "utf8",
    );
    await git(tmpDir, ["add", "."]);
    await git(tmpDir, ["commit", "-m", "feat: add calculateFee and README"]);

    // Commit B (HEAD): update calculateFee runtime logic in src/fee.ts without updating README
    await fs.writeFile(
      feeFile,
      [
        "export function calculateFee(amount: number): number {",
        "  return amount * 0.05;",
        "}",
      ].join("\n"),
      "utf8",
    );
    await git(tmpDir, ["add", "src/fee.ts"]);
    await git(tmpDir, ["commit", "-m", "feat: update calculateFee to 5%"]);

    // Working-tree edit: update README.md AND simultaneously modify src/fee.ts (uncommitted source change)
    await fs.writeFile(
      readmeFile,
      [
        "# Billing",
        "",
        "Call `calculateFee` to compute the 2% fee (updated description).",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      feeFile,
      [
        "export function calculateFee(amount: number): number {",
        "  return amount * 0.02;",
        "}",
      ].join("\n"),
      "utf8",
    );

    // 1. Without --allow-source-change -> must FAIL and report src/fee.ts
    let errNoFlag = "";
    const exitNoFlag = await runCli(["verify", "README.md", "--root", tmpDir], {
      stdout: () => {},
      stderr: (s) => {
        errNoFlag += s;
      },
    });
    expect(exitNoFlag).toBe(1);
    expect(errNoFlag).toContain("src/fee.ts");

    // 2. With --allow-source-change -> must PASS
    let outWithFlag = "";
    let errWithFlag = "";
    const exitWithFlag = await runCli(
      ["verify", "README.md", "--allow-source-change", "--root", tmpDir],
      {
        stdout: (s) => {
          outWithFlag += s;
        },
        stderr: (s) => {
          errWithFlag += s;
        },
      },
    );
    expect(exitWithFlag).toBe(0);
    expect(errWithFlag).toBe("");
    expect(outWithFlag).toContain("VERIFIED");
  });

  it("fails verify README.md when a modified block introduces an unresolvable path claim, enforces --run-docs on modified code blocks, and supports --lines scoping", async () => {
    const feeFile = path.join(tmpDir, "src", "fee.ts");
    const readmeFile = path.join(tmpDir, "README.md");

    // Commit A: synchronized code and README with two paragraphs and a runnable TS block
    await fs.writeFile(
      feeFile,
      [
        "export function calculateFee(amount: number): number {",
        "  return amount * 2;",
        "}",
        "",
        "export function taxFee(amount: number): number {",
        "  return amount * 10;",
        "}",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      readmeFile,
      [
        "# Billing",
        "",
        "Call `calculateFee` to compute fees.",
        "",
        "Call `taxFee` to compute tax.",
        "",
        "```ts",
        "import assert from 'node:assert/strict';",
        "import { calculateFee } from './src/fee.js';",
        "assert.equal(calculateFee(5), 10);",
        "```",
      ].join("\n"),
      "utf8",
    );
    await git(tmpDir, ["add", "."]);
    await git(tmpDir, ["commit", "-m", "feat: initial fee functions and README"]);

    // Commit B (HEAD): update both calculateFee and taxFee runtime logic
    await fs.writeFile(
      feeFile,
      [
        "export function calculateFee(amount: number): number {",
        "  return amount * 3;",
        "}",
        "",
        "export function taxFee(amount: number): number {",
        "  return amount * 20;",
        "}",
      ].join("\n"),
      "utf8",
    );
    await git(tmpDir, ["add", "src/fee.ts"]);
    await git(tmpDir, ["commit", "-m", "feat: update calculateFee to 3x and taxFee to 20x"]);

    // 1. Modified block introduces an unresolvable path claim `src/missing-helper.ts` -> must FAIL
    await fs.writeFile(
      readmeFile,
      [
        "# Billing",
        "",
        "Call `calculateFee` (see `src/missing-helper.ts`) to compute 3x fees.",
        "",
        "Call `taxFee` to compute tax.",
        "",
        "```ts",
        "import assert from 'node:assert/strict';",
        "import { calculateFee } from './src/fee.js';",
        "assert.equal(calculateFee(5), 10);",
        "```",
      ].join("\n"),
      "utf8",
    );

    let errUnresolvedPath = "";
    const exitUnresolvedPath = await runCli(["verify", "README.md", "--root", tmpDir], {
      stdout: () => {},
      stderr: (s) => {
        errUnresolvedPath += s;
      },
    });
    expect(exitUnresolvedPath).toBe(1);
    expect(errUnresolvedPath).toContain("src/missing-helper.ts");

    // 2. Fix line 3 with valid path `src/fee.ts`, verify with `--lines 3-3` -> must PASS even though line 5 (`taxFee`) is not yet updated
    await fs.writeFile(
      readmeFile,
      [
        "# Billing",
        "",
        "Call `calculateFee` in `src/fee.ts` to compute 3x fees.",
        "",
        "Call `taxFee` to compute tax.",
        "",
        "```ts",
        "import assert from 'node:assert/strict';",
        "import { calculateFee } from './src/fee.js';",
        "assert.equal(calculateFee(5), 10);",
        "```",
      ].join("\n"),
      "utf8",
    );

    const exitLines3 = await runCli(
      ["verify", "README.md", "--lines", "3-3", "--root", tmpDir],
      {
        stdout: () => {},
        stderr: () => {},
      },
    );
    expect(exitLines3).toBe(0);

    // 3. With `--run-docs`, modifying the code block with a failing assertion must FAIL, and fixing it to 15 must PASS
    await fs.writeFile(
      readmeFile,
      [
        "# Billing",
        "",
        "Call `calculateFee` in `src/fee.ts` to compute 3x fees.",
        "",
        "Call `taxFee` to compute 20x tax.",
        "",
        "```ts",
        "import assert from 'node:assert/strict';",
        "import { calculateFee } from './src/fee.js';",
        "assert.equal(calculateFee(5), 999);",
        "```",
      ].join("\n"),
      "utf8",
    );

    const exitRunDocsFail = await runCli(
      ["verify", "README.md", "--run-docs", "--root", tmpDir],
      {
        stdout: () => {},
        stderr: () => {},
      },
    );
    expect(exitRunDocsFail).toBe(1);

    await fs.writeFile(
      readmeFile,
      [
        "# Billing",
        "",
        "Call `calculateFee` in `src/fee.ts` to compute 3x fees.",
        "",
        "Call `taxFee` to compute 20x tax.",
        "",
        "```ts",
        "import assert from 'node:assert/strict';",
        "import { calculateFee } from './src/fee.js';",
        "assert.equal(calculateFee(5), 15);",
        "```",
      ].join("\n"),
      "utf8",
    );

    const exitRunDocsPass = await runCli(
      ["verify", "README.md", "--run-docs", "--root", tmpDir],
      {
        stdout: () => {},
        stderr: () => {},
      },
    );
    expect(exitRunDocsPass).toBe(0);
  });

  it("lists deleted doc claims in PR comment when --diff, --pr-comment, and --docs are enabled and a claim whose referent still exists is deleted", async () => {
    const feeFile = path.join(tmpDir, "src", "fee.ts");
    const readmeFile = path.join(tmpDir, "README.md");

    // Commit 1 on main: initial code and README
    await fs.writeFile(
      feeFile,
      [
        "export function calculateFee(amount: number): number {",
        "  return amount * 2;",
        "}",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      readmeFile,
      [
        "# Billing",
        "",
        "Call `calculateFee` to compute fees.",
      ].join("\n"),
      "utf8",
    );
    await git(tmpDir, ["add", "."]);
    await git(tmpDir, ["commit", "-m", "feat: initial fee and README on main"]);

    // Commit 2 on main: update calculateFee runtime logic so `calculateFee` in README is fog-returned
    await fs.writeFile(
      feeFile,
      [
        "export function calculateFee(amount: number): number {",
        "  return amount * 5;",
        "}",
      ].join("\n"),
      "utf8",
    );
    await git(tmpDir, ["add", "src/fee.ts"]);
    await git(tmpDir, ["commit", "-m", "feat: update calculateFee formula on main"]);

    // PR branch: Agent rewrites `calculateFee` in README into vague prose ("相关函数") to silence fog-returned
    await git(tmpDir, ["checkout", "-b", "feat/pr-delete-claim"]);
    await fs.writeFile(
      readmeFile,
      [
        "# Billing",
        "",
        "调用相关函数计算手续费。",
      ].join("\n"),
      "utf8",
    );
    await git(tmpDir, ["add", "README.md"]);
    await git(tmpDir, ["commit", "-m", "docs: vague rewrite removing calculateFee claim"]);

    let jsonOut = "";
    const exitCode = await runCli(
      ["--root", tmpDir, "--docs", "--diff", "main", "--pr-comment", "--json", "--fail-on", "none"],
      {
        stdout: (s) => {
          jsonOut += s;
        },
        stderr: () => {},
      },
    );
    expect(exitCode).toBe(0);

    const report = JSON.parse(jsonOut);
    expect(report.diff.deletedDocClaims).toEqual([
      expect.objectContaining({
        file: "README.md",
        claimText: "calculateFee",
        kind: "symbol",
        line: 3,
        referent: expect.objectContaining({
          kind: "symbol",
          file: "src/fee.ts",
          symbol: "calculateFee",
        }),
      }),
    ]);

    const prComment = await fs.readFile(path.join(tmpDir, ".codefog", "pr-comment.md"), "utf8");
    expect(prComment).toContain("Deleted Doc Claims (1)");
    expect(prComment).toContain("`README.md:3`");
    expect(prComment).toContain("`calculateFee`");
    expect(prComment).toContain("Referent `src/fee.ts` still exists");
  });

  it("handles S2 edge cases: allows uncommitted doc referents, catches untracked code referents, ignores line-overlap-only unrelated functions on delete, catches historical symbols kept in modified blocks, and fails whole-file verify when unmodified fog-returned claims remain", async () => {
    const feeFile = path.join(tmpDir, "src", "fee.ts");
    const guideFile = path.join(tmpDir, "docs", "guide.md");
    const readmeFile = path.join(tmpDir, "README.md");
    await fs.mkdir(path.join(tmpDir, "docs"), { recursive: true });

    // Commit A: legacyDiscount at lines 1-3, calculateFee at lines 5-7, taxFee at lines 9-11
    await fs.writeFile(
      feeFile,
      [
        "export function legacyDiscount(amount: number): number {",
        "  return amount * 0.01;",
        "}",
        "",
        "export function calculateFee(amount: number): number {",
        "  return amount * 2;",
        "}",
        "",
        "export function taxFee(amount: number): number {",
        "  return amount * 10;",
        "}",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(guideFile, "# Guide\n\nInitial guide.\n", "utf8");
    await fs.writeFile(
      readmeFile,
      [
        "# Billing",
        "",
        "See [Guide](docs/guide.md) and call `calculateFee` for fees.",
        "",
        "Call `taxFee` for tax.",
        "",
        "Call `legacyDiscount` for legacy discounts.",
      ].join("\n"),
      "utf8",
    );
    await git(tmpDir, ["add", "."]);
    await git(tmpDir, ["commit", "-m", "feat: initial functions and docs"]);

    // Commit B: delete legacyDiscount at lines 1-3 and put an unrelated function formatLabel at lines 1-3;
    // also change runtime logic of calculateFee and taxFee
    await fs.writeFile(
      feeFile,
      [
        "export function formatLabel(name: string): string {",
        "  return `[${name.trim()}]`;",
        "}",
        "",
        "export function calculateFee(amount: number): number {",
        "  return amount * 3;",
        "}",
        "",
        "export function taxFee(amount: number): number {",
        "  return amount * 20;",
        "}",
      ].join("\n"),
      "utf8",
    );
    await git(tmpDir, ["add", "src/fee.ts"]);
    await git(tmpDir, ["commit", "-m", "feat: replace legacyDiscount with formatLabel and update fee rates"]);

    // Commit C (HEAD): touch a comment in src/fee.ts so legacyDiscount was already absent at HEAD
    await fs.writeFile(
      feeFile,
      [
        "// Billing helpers",
        "export function formatLabel(name: string): string {",
        "  return `[${name.trim()}]`;",
        "}",
        "",
        "export function calculateFee(amount: number): number {",
        "  return amount * 3;",
        "}",
        "",
        "export function taxFee(amount: number): number {",
        "  return amount * 20;",
        "}",
      ].join("\n"),
      "utf8",
    );
    await git(tmpDir, ["add", "src/fee.ts"]);
    await git(tmpDir, ["commit", "-m", "chore: comment header"]);

    // S2d: Modify block 1 (`calculateFee`) and remove `legacyDiscount`, but leave block 2 (`taxFee`) unmodified and still fog-returned.
    // Whole-file verify (without --lines) MUST fail because `taxFee` is still fog-returned!
    await fs.writeFile(
      readmeFile,
      [
        "# Billing",
        "",
        "See [Guide](docs/guide.md) and call `calculateFee` for 3x fees.",
        "",
        "Call `taxFee` for tax.",
      ].join("\n"),
      "utf8",
    );
    let errS2d = "";
    const exitS2d = await runCli(["verify", "README.md", "--root", tmpDir], {
      stdout: () => {},
      stderr: (s) => {
        errS2d += s;
      },
    });
    expect(exitS2d).toBe(1);
    expect(errS2d).toContain("taxFee");

    // S2c: Modify the `legacyDiscount` block to still call `legacyDiscount()` (resolves neither now nor at HEAD, but did resolve at Commit A).
    // Even when `calculateFee` and `taxFee` are updated, keeping `legacyDiscount()` in a modified block MUST fail!
    await fs.writeFile(
      readmeFile,
      [
        "# Billing",
        "",
        "See [Guide](docs/guide.md) and call `calculateFee` for 3x fees.",
        "",
        "Call `taxFee` for 20x tax.",
        "",
        "Call `legacyDiscount()` when applicable.",
      ].join("\n"),
      "utf8",
    );
    let errS2c = "";
    const exitS2c = await runCli(["verify", "README.md", "--root", tmpDir], {
      stdout: () => {},
      stderr: (s) => {
        errS2c += s;
      },
    });
    expect(exitS2c).toBe(1);
    expect(errS2c).toContain("legacyDiscount");

    // S2b + S2a (part 1): Delete the `legacyDiscount` block (genuine deletion despite `formatLabel` overlapping lines 1-3)
    // AND modify `docs/guide.md` (a non-code doc referent) in the working tree -> verify README.md MUST PASS!
    await fs.writeFile(guideFile, "# Guide\n\nUpdated guide in working tree.\n", "utf8");
    await fs.writeFile(
      readmeFile,
      [
        "# Billing",
        "",
        "See [Guide](docs/guide.md) and call `calculateFee` for 3x fees.",
        "",
        "Call `taxFee` for 20x tax.",
      ].join("\n"),
      "utf8",
    );
    let errS2ab = "";
    const exitS2ab = await runCli(["verify", "README.md", "--root", tmpDir], {
      stdout: () => {},
      stderr: (s) => {
        errS2ab += s;
      },
    });
    expect(exitS2ab).toBe(0);
    expect(errS2ab).toBe("");

    // S2a (part 2): Create a new untracked source file `src/new-helper.ts` (HEAD text null) and reference it in README.md ->
    // verify README.md without --allow-source-change MUST FAIL on `src/new-helper.ts`!
    await fs.writeFile(
      path.join(tmpDir, "src", "new-helper.ts"),
      "export function extraHelper(): number {\n  return 42;\n}\n",
      "utf8",
    );
    await fs.writeFile(
      readmeFile,
      [
        "# Billing",
        "",
        "See [Guide](docs/guide.md) and call `calculateFee` or `extraHelper` in `src/new-helper.ts` for 3x fees.",
        "",
        "Call `taxFee` for 20x tax.",
      ].join("\n"),
      "utf8",
    );
    let errUntracked = "";
    const exitUntracked = await runCli(["verify", "README.md", "--root", tmpDir], {
      stdout: () => {},
      stderr: (s) => {
        errUntracked += s;
      },
    });
    expect(exitUntracked).toBe(1);
    expect(errUntracked).toContain("src/new-helper.ts");
  });
});
