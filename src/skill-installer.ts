import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

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

export function renderCodefogSkillMarkdown(): string {
  return `---
name: codefog
description: Evaluate repository code quality and test trust with codefog, produce a structured five-state diagnosis (fog-returned, fog, self-proof-fog, weak-evidence, verified), and run a continuous test-strengthening and mutation-verification loop until the target Trust Score or zero-fog goal is reached. Use when the user asks to evaluate code or test quality, measure Trust Score, clear code fog, fix pseudo-tested or weak-evidence methods, or iteratively optimize repository verification.
---

# Codefog Quality Evaluation & Continuous Optimization Loop

Drive the repository from unverified or degraded test coverage to verified behavioral trust using \`@barryzhu/codefog\`. Execute the loop below in order: **Baseline Evaluation → Structured Conclusion → Iterative Optimization & Mutation Verification → Goal Convergence**.

---

## Step 1: Run Baseline Evaluation

1. **Generate fresh coverage data** for the repository's language stack (if not already present or if source/tests changed):
   - **TypeScript / JavaScript**: \`npx vitest run --coverage.enabled=true --coverage.reporter=lcov\` (or \`npx jest --coverage\`)
   - **Go**: \`go test -coverprofile=coverage.out ./...\`
   - **Rust**: \`cargo llvm-cov --lcov --output-path coverage/lcov.info\`
   - **Java**: \`mvn test jacoco:report\` (or \`./gradlew test jacocoTestReport\`)
2. **Execute \`codefog\`** to compute the five-state Fog Map and JSON report:
   \`\`\`bash
   npx --yes @barryzhu/codefog@latest --fail-on none
   \`\`\`
   To inspect machine-readable findings (\`CF-xxxx\`), run:
   \`\`\`bash
   npx --yes @barryzhu/codefog@latest --json --fail-on none
   \`\`\`
   *(Note: \`.codefog/report.html\` is automatically generated on default runs.)*

**Completion criterion**: You have the current \`Trust Score\`, metrics breakdown, five-state LOC counts, and the ranked list of \`findings\`.

---

## Step 2: Deliver Structured Evaluation Conclusion

Before editing any tests, present a concise evaluation conclusion to the user using this structure:

\`\`\`markdown
## Codefog 评测结论 (Evaluation Summary)

- **Trust Score（信任分）**: <score>/100 （目标: <target>/100）
- **核心指标**:的行覆盖 <line>% | 分支覆盖 <branch>% | 检验覆盖 (Checked) <checked>% | 伪测试方法 (Pseudo-tested): <count>
- **五态分布 (LOC)**:
  - \`fog-returned\` (回雾/高危退化): <n>
  - \`fog\` (未覆盖盲区): <n>
  - \`self-proof-fog\` (同提交自证雾): <n>
  - \`weak-evidence\` (弱证据/缺结果断言或分支不全): <n>
  - \`verified\` (已验证): <n>

### 核心风险热点与诊断 (Top Findings)
1. **[CF-xxxx] \`<file>:<start>-<end>\` (\`<symbol>\`)** — 状态: \`<state>\` | Risk: \`<riskScore>\`
   - **根因诊断**: <reason (e.g., 代码逻辑改动晚于测试 / 仅有非空存活性检查无业务值断言 / 分支未覆盖)>
   - **优化动作**: <suggestedAction>
\`\`\`

### Target Goal Definition
Unless the user specifies a custom threshold, set the optimization target to:
1. **Zero \`fog-returned\`** (\`locByState["fog-returned"] === 0\`)
2. **Zero \`pseudoTestedMethods\`** (\`metrics.pseudoTestedMethods === 0\`)
3. **\`Trust Score >= 85\`** (or resolve all high-risk findings with \`riskScore >= 5.0\`)
4. **Zero Oracle Contests** (\`metrics.contestedOracles === 0\`)

---

## Step 3: Continuous Optimization & Anti-Gaming Verification Loop

Iterate through the highest-risk findings in priority order (\`fog-returned\` → \`fog\` → \`weak-evidence\`). Skip every finding whose \`agentReady\` is \`false\`. Those are Coupled Assertions still in Self-proof Fog, or an Oracle Contest against an Independent Expectation or Historical Defect. Do not edit the outcome assertion literal to match the current return value. Stop and ask a human to confirm the expectation or defect record.

### 3.1 Strengthen Test Evidence with Outcome Assertions
- Read the production function at \`location.file\` (\`startLine\`–\`endLine\`) and its associated test file.
- Write or update tests with explicit **Outcome Assertions** on concrete return values, state transitions, boundary conditions, and expected error payloads:
  - **TS/JS**: \`expect(fn(input)).toEqual(expectedValue)\` (replace shallow \`toBeDefined()\` / \`toBeTruthy()\`)
  - **Go**: compare concrete values (\`if got != want\`, \`reflect.DeepEqual\`, \`cmp.Diff\`, \`require.Equal\`; do not stop at \`if err != nil\` when the function also returns a domain value)
  - **Rust**: \`assert_eq!(got, want)\`, \`matches!\` (replace bare \`.unwrap()\` / \`assert!(res.is_ok())\`)
  - **Java**: \`assertEquals(want, got)\`, \`assertThat(got).isEqualTo(want)\` (replace bare \`assertNotNull\`)
- **Anti-gaming guardrail**: Keep production business branches intact. Never delete production conditional branches or weaken production logic to inflate coverage.

### 3.2 Run the Single-File Mutation Gate (\`codefog verify\`)
Immediately run the finding's acceptance command:
\`\`\`bash
npx --yes @barryzhu/codefog@latest verify <file> --mutants --lines <startLine>-<endLine>
\`\`\`
- **If \`verify\` exits with \`1\`**:
  - Inspect the reported **surviving mutants** (e.g. \`line 42: '<=' -> '<'\`) or **body-clearance survival** (pseudo-tested method).
  - Add boundary and behavioral assertions that specifically fail when those mutations are injected.
  - Re-run \`codefog verify\` until it exits with \`0\` (\`PASS\`).

### 3.3 Refresh Coverage & Re-evaluate Repository State
After verifying the target file(s):
1. Re-run the language test coverage command (Step 1.1) so the coverage artifact reflects the new tests.
2. Re-run \`npx --yes @barryzhu/codefog@latest --fail-on none\`.
3. Compare the new \`Trust Score\`, \`checkedCoveragePct\`, and remaining \`findings\` against the target goal.

**Loop condition**: If the target goal is not yet met and actionable findings remain, immediately start the next iteration on the next highest-risk finding.

---

## Step 4: Final Convergence Report

Once the target goal is achieved (and \`npx --yes @barryzhu/codefog@latest --fail-on returned\` exits \`0\`), report the before/after comparison:

- **Trust Score Delta**: \`<before> → <after> (+<delta>)\`
- **Checked Coverage Delta**: \`<before>% → <after>%\`
- **Findings Resolved**: list each \`CF-xxxx\` finding transitions (e.g. \`fog-returned → verified\`) and the mutation kill rate verified by \`codefog verify --mutants\`.
- **Visual Fog Map**: remind the user they can open \`.codefog/report.html\` (or run \`npx @barryzhu/codefog@latest --open\`) to inspect the updated interactive Fog Map.
`;
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
