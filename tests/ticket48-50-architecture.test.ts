import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeRepository, runCli, verifyTargetWithMutants } from "../src/index.js";

const directories: string[] = [];

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codefog-arch-"));
  directories.push(root);
  return root;
}

async function write(root: string, file: string, text: string): Promise<void> {
  const target = path.join(root, file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, text);
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function init(root: string): void {
  git(root, "init", "-q");
  git(root, "config", "user.name", "Codefog Test");
  git(root, "config", "user.email", "codefog@example.test");
}

function commit(root: string, description: string): string {
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "--allow-empty", "-m", description);
  return git(root, "rev-parse", "HEAD");
}

async function cli(root: string, ...args: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await runCli([...args, "--root", root], {
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
  });
  return { code, stdout, stderr };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const forbidDb = {
  modules: {
    routes: ["src/routes/**"],
    db: ["src/db/**"],
    service: ["src/service/**"],
  },
  rules: [{ from: "routes", to: "db", effect: "forbid", because: "Use the service layer." }],
};

describe("architecture graph", () => {
  it.each([
    {
      files: {
        "src/a/a.ts": "import { b } from '../b/b.js';\nexport function a() { return b(); }\n",
        "src/b/b.ts": "import type { A } from '../a/a.js';\nexport function b() { return 1; }\n",
      },
      modules: ["src/a", "src/b"],
    },
    {
      files: {
        "go.mod": "module example.test/app\n",
        "pkg/a/a.go": "package a\nimport \"example.test/app/pkg/b\"\nfunc A() int { return b.B() }\n",
        "pkg/b/b.go": "package b\nimport \"example.test/app/pkg/a\"\nfunc B() int { return 1 }\n",
      },
      modules: ["pkg/a", "pkg/b"],
    },
    {
      files: {
        "src/lib.rs": "mod a;\nmod b;\n",
        "src/a/mod.rs": "use crate::b::b;\npub fn a() -> i32 { b() }\n",
        "src/b/mod.rs": "use crate::a::a;\npub fn b() -> i32 { 1 }\n",
      },
      modules: ["src/a", "src/b"],
    },
    {
      files: {
        "src/main/java/example/a/A.java": "package example.a;\nimport example.b.B;\npublic class A {\n  public int value() { return 1; }\n}\n",
        "src/main/java/example/b/B.java": "package example.b;\nimport example.a.A;\npublic class B {\n  public int value() { return 2; }\n}\n",
      },
      modules: ["src/main/java/example/a", "src/main/java/example/b"],
    },
  ])("reports a cycle for $modules without altering evidence totals", async ({ files, modules }) => {
    const root = await fixture();
    for (const [file, source] of Object.entries(files)) {
      if (source !== undefined) await write(root, file, source);
    }
    const plain = await analyzeRepository({ rootDir: root });
    const report = await analyzeRepository({ rootDir: root, arch: true });
    expect(plain.architecture).toBeUndefined();
    expect(report.summary).toEqual(plain.summary);
    expect(report.architecture?.cycles).toEqual([
      expect.objectContaining({
        modules,
        edges: expect.arrayContaining([
          { from: modules[0], to: modules[1] },
          { from: modules[1], to: modules[0] },
        ]),
      }),
    ]);
    expect(report.architecture?.propagationCostPct).toBeGreaterThan(0);
    expect(report.findings).toContainEqual(expect.objectContaining({
      subjectType: "architecture",
      tags: ["arch-cycle", "boundary-violation"],
    }));
    expect(report.warnings?.join("\n")).toContain("Implicit Coupling");
    await write(root, ".codefog/architecture.json", '{"noCycles":false}');
    const relaxed = await analyzeRepository({ rootDir: root });
    expect(relaxed.architecture?.cycles).toHaveLength(1);
    expect(relaxed.architecture?.boundaryViolations).toEqual([]);
  });

  it("uses production fan-in and Git history for hubs and co-change", async () => {
    const root = await fixture();
    init(root);
    const weakHub = "src/core/weak.ts";
    const verifiedHub = "src/core/verified.ts";
    const paired = ["src/client/view.ts", "src/format/line.ts"];
    const noisy = ["src/noisy/one.ts", "src/unrelated/two.ts"];
    for (let i = 0; i < 6; i++) {
      await write(root, `src/downstream/user-${i}.ts`, [
        "import { weak } from '../core/weak.js';",
        "import { verified } from '../core/verified.js';",
        `export function user${i}() { return weak() + verified(); }`,
      ].join("\n"));
    }
    await write(root, "tests/verified.test.ts", [
      "import { expect, it } from 'vitest';",
      "import { verified } from '../src/core/verified.js';",
      "it('returns the threshold', () => expect(verified()).toBe(4));",
    ].join("\n"));
    for (let i = 1; i <= 4; i++) {
      await write(root, weakHub, `export function weak() { return ${i}; }\n`);
      await write(root, verifiedHub, `export function verified() { return ${i}; }\n`);
      for (const file of paired) await write(root, file, `export const value = ${i};\n`);
      await write(root, "src/test/view.test.ts", `export const data = ${i};\n`);
      commit(root, `paired changes ${i}`);
    }
    // Refresh the outcome assertion after the last change to the verified function.
    await write(root, "tests/verified.test.ts", (await fs.readFile(path.join(root, "tests/verified.test.ts"), "utf8")) + "\n");
    commit(root, "refresh coverage expectation");
    for (let i = 1; i <= 3; i++) {
      for (const file of noisy) await write(root, file, `export const value = ${i};\n`);
      for (let j = 0; j < 30; j++) await write(root, `data/${j}.txt`, `${i}\n`);
      commit(root, `bulk change ${i}`);
    }
    commit(root, "checkpoint 1");
    commit(root, "checkpoint 2");
    await write(root, "coverage/lcov.info", [
      `SF:${verifiedHub}`, "FN:1,verified", "FNDA:1,verified", "DA:1,1", "LF:1", "LH:1", "end_of_record", "",
    ].join("\n"));

    const report = await analyzeRepository({ rootDir: root, arch: true });
    expect(report.architecture?.unstableHubs).toEqual([
      expect.objectContaining({ file: weakHub, fanIn: 6, churn90d: 4 }),
    ]);
    expect(report.architecture?.implicitCouplings).toContainEqual({
      from: paired[0], to: paired[1], coChange: 4, coupling: 1,
    });
    expect(report.architecture?.implicitCouplings.some(({ from, to }) =>
      [from, to].some((file) => file.endsWith(".test.ts") || noisy.includes(file)),
    )).toBe(false);
    expect(report.warnings?.join("\n")).not.toContain("Implicit Coupling");
    expect((await cli(root, "--arch", "--json", "--fail-on", "arch-violation")).code).toBe(0);

    const shallow = await fixture();
    git(shallow, "clone", "-q", "--depth", "1", `file://${root}`, ".");
    const shallowReport = await analyzeRepository({ rootDir: shallow, arch: true });
    expect(shallowReport.warnings?.join("\n")).toContain("Implicit Coupling");
    expect(shallowReport.architecture?.implicitCouplings).toEqual([]);
  });

  it("keeps source links for modules that have no executable coverage regions", async () => {
    const root = await fixture();
    await write(root, "src/main/java/example/a/A.java", "package example.a;\nimport example.b.B;\npublic class A {}\n");
    await write(root, "src/main/java/example/b/B.java", "package example.b;\nimport example.a.A;\npublic class B {}\n");
    const report = await analyzeRepository({ rootDir: root, arch: true });
    const [cycle] = report.architecture!.cycles;
    expect(report.summary.totalLoc).toBe(0);
    expect(report.architecture?.sourceFiles?.[cycle!.file]).toContain("import example.b.B;");
  });
});

describe("Architecture Contract gates", () => {
  it("validates, auto-loads, checks public entry, and applies precise baseline keys", async () => {
    const root = await fixture();
    const config = { ...forbidDb, publicEntry: { db: ["src/db/index.ts"] } };
    await write(root, ".codefog/architecture.json", JSON.stringify(config));
    await write(root, "src/db/index.ts", "export { load } from './store.js';\n");
    await write(root, "src/db/store.ts", "export function load() { return 2; }\n");
    await write(root, "src/routes/export.ts", "export { load } from '../db/store.js';\n");
    await write(root, "src/service/read.ts", "export { load } from '../db/index.js';\n");
    const report = await analyzeRepository({ rootDir: root });
    const violations = report.architecture!.boundaryViolations;
    expect(violations.map(({ kind }) => kind)).toEqual(["rule", "public-entry"]);
    expect(report.findings).toContainEqual(expect.objectContaining({ reason: expect.stringContaining("Use the service layer.") }));
    expect((await cli(root, "--json", "--fail-on", "returned,arch-violation")).code).toBe(1);

    await write(root, ".codefog/architecture.json", JSON.stringify({
      ...config,
      baseline: violations.map(({ baselineKey }) => baselineKey),
    }));
    const baselined = await analyzeRepository({ rootDir: root });
    expect(baselined.architecture?.boundaryViolations.every(({ baselined }) => baselined)).toBe(true);
    expect((await cli(root, "--json", "--fail-on", "arch-violation")).code).toBe(0);

    await write(root, "src/routes/new.ts", "export { load } from '../db/store.js';\n");
    expect((await cli(root, "--json", "--fail-on", "returned,arch-violation")).code).toBe(1);
    const missing = await cli(root, "--arch-config", "nope.json", "--json");
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("Architecture Contract file not found");
    await write(root, "broken.json", '{"rules":[{"from":"routes","to":"db","effect":"forbid"}]}');
    const invalid = await cli(root, "--arch-config", "broken.json", "--json");
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toMatch(/Invalid Architecture Contract .*rules\[0\]/);
    expect((await cli(root, "--json", "--fail-on", "returned,bogus")).stderr).toContain("bogus");
  });

  it("rejects newly forbidden file edges under regression and permits existing edges", async () => {
    const root = await fixture();
    init(root);
    await write(root, "contracts/layers.json", JSON.stringify(forbidDb));
    await write(root, "src/db/one.ts", "export function one() { return 1; }\n");
    await write(root, "src/db/two.ts", "export function two() { return 2; }\n");
    await write(root, "src/routes/export.ts", "import { one } from '../db/one.js';\nexport function read() { return one(); }\n");
    const base = commit(root, "known boundary debt");
    const args = ["--arch-config", "contracts/layers.json", "--diff", base, "--fail-on", "regression", "--json"];
    expect((await cli(root, ...args)).code).toBe(0);

    await write(root, "src/routes/export.ts", "import { two } from '../db/two.js';\nexport function read() { return two(); }\n");
    const delta = await cli(root, ...args);
    expect(delta.code).toBe(1);
    expect(JSON.parse(delta.stdout).diff.newBoundaryViolations).toEqual([
      expect.objectContaining({ baselineKey: { kind: "rule", from: "src/routes/export.ts", to: "src/db/two.ts" } }),
    ]);
    await write(root, ".gitignore", "/src/routes/export.ts\n");
    const tracked = await cli(root, "--arch-config", "contracts/layers.json", "--fail-on", "arch-violation", "--json");
    expect(tracked.code).toBe(1);
    expect(JSON.parse(tracked.stdout).architecture.boundaryViolations).toHaveLength(1);
  });

  it("rejects a forbidden import after mutants are killed, then verifies an allowed route", async () => {
    const root = await fixture();
    const target = "src/routes/export.mjs";
    await write(root, ".codefog/architecture.json", JSON.stringify(forbidDb));
    await write(root, "src/db/store.mjs", "export function load() { return 2; }\n");
    await write(root, "src/service/read.mjs", "export { load } from '../db/store.mjs';\n");
    await write(root, "tests/route.test.ts", "import { expect, it } from 'vitest';\nimport { route } from '../src/routes/export.mjs';\nit('exports the record', () => expect(route()).toBe(2));\n");
    await write(root, "run.mjs", "import assert from 'node:assert/strict';\nimport { route } from './src/routes/export.mjs';\nassert.equal(route(), 2);\n");
    const source = "import { load } from '../db/store.mjs';\nexport function route() { return load(); }\n";
    await write(root, target, source);
    const options = { rootDir: root, targetFile: target, mutants: true, testCmd: "node run.mjs" };
    const blocked = await verifyTargetWithMutants(options);
    expect(blocked.exitCode).toBe(1);
    expect(blocked.violations.join("\n")).toContain("Use the service layer.");
    expect(blocked.totalMutants).toBeGreaterThan(0);
    expect(blocked.killedMutants).toBe(blocked.totalMutants);
    expect(await fs.readFile(path.join(root, target), "utf8")).toBe(source);

    await write(root, ".codefog/architecture.json", JSON.stringify({
      ...forbidDb, baseline: [{ kind: "rule", from: target, to: "src/db/store.mjs" }],
    }));
    const args = ["verify", target, "--mutants", "--test-cmd", "node run.mjs"];
    expect((await cli(root, ...args)).code).toBe(0);

    await write(root, "src/routes/other.mjs", source);
    await write(root, target, source.replace("../db/store.mjs", "../service/read.mjs"));
    await write(root, "custom-arch.json", JSON.stringify(forbidDb));
    expect((await cli(root, ...args, "--arch-config", "custom-arch.json")).code).toBe(0);
  });
});
