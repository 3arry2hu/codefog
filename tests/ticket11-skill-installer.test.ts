import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { runCli } from "../src/cli.js";

describe("AI Skill generator and multi-agent installer (codex, claude-code, codebuddy, cursor)", () => {
  let tmpProjectDir: string;
  let tmpHomeDir: string;

  beforeEach(async () => {
    tmpProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefog-skill-proj-"));
    tmpHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefog-skill-home-"));
  });

  afterEach(async () => {
    await fs.rm(tmpProjectDir, { recursive: true, force: true });
    await fs.rm(tmpHomeDir, { recursive: true, force: true });
  });

  it("installs the codefog SKILL.md for all 4 agents (codex, claude-code, codebuddy, cursor) at project level by default", async () => {
    let out = "";
    let err = "";
    const exitCode = await runCli(["install-skill", "--root", tmpProjectDir], {
      stdout: (s) => {
        out += s;
      },
      stderr: (s) => {
        err += s;
      },
    });

    expect(exitCode).toBe(0);
    expect(err).toBe("");
    expect(out).toContain("codex");
    expect(out).toContain("claude-code");
    expect(out).toContain("codebuddy");
    expect(out).toContain("cursor");

    const expectedPaths = [
      path.join(tmpProjectDir, ".codex", "skills", "codefog", "SKILL.md"),
      path.join(tmpProjectDir, ".claude", "skills", "codefog", "SKILL.md"),
      path.join(tmpProjectDir, ".codebuddy", "skills", "codefog", "SKILL.md"),
      path.join(tmpProjectDir, ".cursor", "skills", "codefog", "SKILL.md"),
    ];

    for (const skillPath of expectedPaths) {
      const content = await fs.readFile(skillPath, "utf8");
      // Valid YAML frontmatter
      expect(content).toMatch(/^---\nname: codefog\ndescription: .+\n---/s);
      // Contains evaluation, conclusion, iterative optimization loop, and verification gate
      expect(content).toContain("npx @barryzhu/codefog");
      expect(content).toContain("Trust Score");
      expect(content).toContain("fog-returned");
      expect(content).toContain("verify");
      expect(content).toContain("--mutants");
    }
  });

  it("supports filtering specific agents (--agent cursor,claude-code) and global installation (--global)", async () => {
    const prevHome = process.env.CODEFOG_SKILL_HOME;
    try {
      process.env.CODEFOG_SKILL_HOME = tmpHomeDir;
      let out = "";
      const exitCode = await runCli(
        ["install-skill", "--agent", "cursor,claude", "--global"],
        {
          stdout: (s) => {
            out += s;
          },
          stderr: () => {},
        },
      );

      expect(exitCode).toBe(0);
      expect(out).toContain("cursor");
      expect(out).toContain("claude-code");

      const cursorGlobal = path.join(tmpHomeDir, ".cursor", "skills", "codefog", "SKILL.md");
      const claudeGlobal = path.join(tmpHomeDir, ".claude", "skills", "codefog", "SKILL.md");
      const codexGlobal = path.join(tmpHomeDir, ".codex", "skills", "codefog", "SKILL.md");

      const cursorStat = await fs.stat(cursorGlobal);
      const claudeStat = await fs.stat(claudeGlobal);
      expect(cursorStat.isFile()).toBe(true);
      expect(claudeStat.isFile()).toBe(true);

      await expect(fs.access(codexGlobal)).rejects.toThrow();
    } finally {
      if (prevHome === undefined) {
        delete process.env.CODEFOG_SKILL_HOME;
      } else {
        process.env.CODEFOG_SKILL_HOME = prevHome;
      }
    }
  });

  it("supports `--install-skill` flag alias and positional agent names when npx strips flags", async () => {
    let out = "";
    const exitCode = await runCli(
      ["--install-skill", "codebuddy", "--root", tmpProjectDir],
      {
        stdout: (s) => {
          out += s;
        },
        stderr: () => {},
      },
    );

    expect(exitCode).toBe(0);
    expect(out).toContain("codebuddy");
    const buddySkill = path.join(tmpProjectDir, ".codebuddy", "skills", "codefog", "SKILL.md");
    const content = await fs.readFile(buddySkill, "utf8");
    expect(content).toContain("name: codefog");
  });
});
