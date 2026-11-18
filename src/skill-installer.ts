import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export type SupportedSkillAgent = "codex" | "claude-code" | "codebuddy" | "cursor";

export const SUPPORTED_SKILL_AGENTS: readonly SupportedSkillAgent[] = [
  "codex",
  "claude-code",
  "codebuddy",
  "cursor",
];

const AGENT_SKILL_REL_DIRS: Record<SupportedSkillAgent, string[]> = {
  codex: [".codex/skills/codefog", ".agents/skills/codefog"],
  "claude-code": [".claude/skills/codefog"],
  codebuddy: [".codebuddy/skills/codefog"],
  cursor: [".cursor/skills/codefog"],
};

export interface InstallSkillOptions {
  rootDir?: string;
  homeDir?: string;
  agents?: string | string[];
  global?: boolean;
}

export interface InstalledSkillTarget {
  agent: SupportedSkillAgent;
  scope: "project" | "global";
  skillPath: string;
}

export interface InstallSkillResult {
  targets: InstalledSkillTarget[];
  summary: string;
}

export function normalizeSkillAgents(
  rawAgents?: string | string[],
): SupportedSkillAgent[] {
  if (!rawAgents) {
    return [...SUPPORTED_SKILL_AGENTS];
  }
  const items = (Array.isArray(rawAgents) ? rawAgents : [rawAgents])
    .flatMap((item) => item.split(","))
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (items.length === 0 || items.includes("all")) {
    return [...SUPPORTED_SKILL_AGENTS];
  }

  const resolved = new Set<SupportedSkillAgent>();
  for (const item of items) {
    if (item === "codex" || item === "openai-codex") {
      resolved.add("codex");
    } else if (item === "claude-code" || item === "claude" || item === "claudecode") {
      resolved.add("claude-code");
    } else if (item === "codebuddy" || item === "buddy" || item === "tencent-codebuddy") {
      resolved.add("codebuddy");
    } else if (item === "cursor") {
      resolved.add("cursor");
    } else {
      throw new Error(
        `Unknown AI agent '${item}'. Supported agents: codex, claude-code, codebuddy, cursor, all.`,
      );
    }
  }
  return Array.from(resolved);
}

const CANONICAL_SKILL_PATH = fileURLToPath(
  new URL("../skills/codefog/SKILL.md", import.meta.url),
);

let cachedSkillMarkdown: string | undefined;

export function renderCodefogSkillMarkdown(): string {
  if (cachedSkillMarkdown === undefined) {
    cachedSkillMarkdown = fsSync.readFileSync(CANONICAL_SKILL_PATH, "utf8");
  }
  return cachedSkillMarkdown;
}

export async function installCodefogSkill(
  options: InstallSkillOptions = {},
): Promise<InstallSkillResult> {
  const agents = normalizeSkillAgents(options.agents);
  const scope: "project" | "global" = options.global ? "global" : "project";
  const baseDir = options.global
    ? path.resolve(options.homeDir || process.env.CODEFOG_SKILL_HOME || os.homedir())
    : path.resolve(options.rootDir || process.cwd());

  const skillContent = renderCodefogSkillMarkdown();
  const targets: InstalledSkillTarget[] = [];

  for (const agent of agents) {
    const relDirs = AGENT_SKILL_REL_DIRS[agent];
    for (const relDir of relDirs) {
      const targetDir = path.join(baseDir, relDir);
      const skillPath = path.join(targetDir, "SKILL.md");
      await fs.mkdir(targetDir, { recursive: true });
      await fs.writeFile(skillPath, skillContent, "utf8");
      targets.push({
        agent,
        scope,
        skillPath,
      });
    }
  }

  const lines: string[] = [
    `codefog AI skill installed (${scope} scope) for: ${agents.join(", ")}`,
    "",
    "Installed skill files:",
    ...targets.map((t) => `  - [${t.agent}] ${t.skillPath}`),
    "",
    "How to trigger in your AI coding agent (Codex, Claude Code, CodeBuddy, Cursor):",
    '  Ask: "Use /codefog to evaluate this project\'s code quality and iteratively optimize tests until Trust Score reaches the target."',
  ];

  return {
    targets,
    summary: lines.join("\n"),
  };
}
