# `codefog` AI Skill 使用指南（Codex / Claude Code / CodeBuddy / Cursor）

`codefog` 内置了专为 AI 编码代理（AI Coding Agent）设计的 **`codefog` Skill**。安装该 Skill 后，**Codex**、**Claude Code**、**CodeBuddy** 和 **Cursor** 能够自动对当前项目执行“雾优先（Fog-first）”代码质量与测试可信度评测，输出结构化诊断结论，并**自动进入「补强结果断言 → 反作弊变异验证 → 刷新全仓评分」的持续迭代闭环**，直到达到目标代码信任分（`Trust Score`）。

---

## 目录

1. [为什么需要 `codefog` AI Skill？](#1-为什么需要-codefog-ai-skill)
2. [通过 `npx` 一键安装 Skill](#2-通过-npx-一键安装-skill)
3. [在四大 AI 工具中如何触发与使用](#3-在四大-ai-工具中如何触发与使用)
4. [开箱即用的提示词（Prompt）模板库](#4-开箱即用的提示词prompt模板库)
5. [Skill 四阶段自动闭环工作流详解](#5-skill-四阶段自动闭环工作流详解)
6. [实战演练：一次完整的 Agent 评测与迭代过程](#6-实战演练一次完整的-agent-评测与迭代过程)
7. [常见问题与排查（FAQ）](#7-常见问题与排查faq)

---

## 1. 为什么需要 `codefog` AI Skill？

当直接让普通 AI Agent “帮我提高测试覆盖率”或“评测代码质量”时，往往会出现三类典型问题：
1. **刷覆盖率而不写实质断言（伪测试 / Liveness Only）**：AI 为了凑高行覆盖率，只调用函数或只写 `expect(res).toBeDefined()`、`if err != nil`、`assert!(res.is_ok())`、`assertNotNull(res)`，即使业务计算逻辑完全算错，测试依然全部绿灯通过。
2. **删减生产代码分支作弊**：遇到难以构造测试的异常分支时，AI 可能会偷偷修改甚至删掉生产源码里的分支来“消灭未覆盖行”。
3. **单次修改后缺乏闭环验证**：AI 写完一两个测试就停止，既不验证变异体是否被真正杀死，也不持续追踪全仓指标是否收敛达标。

`codefog` Skill 为 AI Agent 注入了一套严格的**评测与反作弊迭代协议**：
- **先评测、给结论**：强制 Agent 先产出五态证据分布、`Trust Score` 及高风险 `Finding` (`CF-xxxx`) 的根因报告；
- **反作弊变异门禁**：每改完一个测试，强制调用 `codefog verify <file> --mutants` 进行函数体零值清空（Body Clearance）与算子翻转验证，禁止修改生产代码分支；
- **多轮持续收敛**：未达标自动开启下一轮迭代，直至达到目标 `Trust Score` 并清零高危项。

---

## 2. 通过 `npx` 一键安装 Skill

无需预先克隆仓库或全局安装 CLI，直接在终端运行 `npx` 即可生成并安装 `SKILL.md`。

### 2.1 在当前项目中为全部四大工具安装（推荐）

在你的项目根目录下执行：

```bash
npx @barryzhu/codefog@latest install-skill
```

该命令会自动在当前仓库下为 **Codex**、**Claude Code**、**CodeBuddy**、**Cursor** 生成对应的 Skill 文件，你可以选择将它们提交到 Git 仓库中供团队共享，或加入 `.gitignore`。

### 2.2 仅针对特定 AI 工具安装（`--agent`）

如果你只使用某一款或几款工具，可通过 `--agent`（或直接跟工具名称）指定：

```bash
# 仅为 Cursor 安装
npx @barryzhu/codefog@latest install-skill --agent cursor

# 同时为 Cursor 和 Claude Code 安装（逗号分隔）
npx @barryzhu/codefog@latest install-skill --agent cursor,claude-code

# 简写形式（兼容旧版 npx）
npx @barryzhu/codefog@latest install-skill codex
```

支持的工具标识（大小写不敏感）：
- `codex`（OpenAI Codex CLI 及通用 `.agents/skills` 规范）
- `claude-code`（支持简写为 `claude`）
- `codebuddy`
- `cursor`
- `all`（默认，安装全部四个平台）

### 2.3 全局安装到用户主目录（`--global` / `-g`）

如果希望本机所有项目都能直接使用 `codefog` Skill，无需在每个项目里重复安装，可加上 `--global`（或 `-g`）：

```bash
# 为全部四大工具进行全局安装
npx @barryzhu/codefog@latest install-skill --global

# 仅为 Claude Code 和 Cursor 进行全局安装
npx @barryzhu/codefog@latest install-skill --global --agent claude-code,cursor
```

### 2.4 为指定项目路径安装（`--root`）

```bash
npx @barryzhu/codefog@latest install-skill --root /path/to/your/repo
```

### 2.5 各平台安装路径对照表

| AI 平台 (`--agent`) | 项目级安装路径（默认） | 全局安装路径（`--global` / `-g`） |
| :--- | :--- | :--- |
| **Codex** (`codex`) | `.codex/skills/codefog/SKILL.md`<br>`.agents/skills/codefog/SKILL.md` | `~/.codex/skills/codefog/SKILL.md`<br>`~/.agents/skills/codefog/SKILL.md` |
| **Claude Code** (`claude-code`) | `.claude/skills/codefog/SKILL.md` | `~/.claude/skills/codefog/SKILL.md` |
| **CodeBuddy** (`codebuddy`) | `.codebuddy/skills/codefog/SKILL.md` | `~/.codebuddy/skills/codefog/SKILL.md` |
| **Cursor** (`cursor`) | `.cursor/skills/codefog/SKILL.md` | `~/.cursor/skills/codefog/SKILL.md` |

> **版本提示**：建议本地 `npm` / `npx` 版本 `>= 9.0.0`。若在旧版 `npm`（如 `8.15.0`）下运行，建议升级 `npm install -g npm@latest`，或使用位置参数简写 `npx @barryzhu/codefog@latest install-skill cursor`。

---

## 3. 在四大 AI 工具中如何触发与使用

安装完成后，各大 AI 编码工具会自动发现 `skills/codefog/SKILL.md`。你可以通过以下方式触发它：

### 3.1 在 Cursor 中使用
1. 打开 Cursor 的 **Agent Chat** 面板。
2. 直接在自然语言中提及 `codefog` 或“代码质量评测”（Cursor 会根据 Skill 的 `description` 自动匹配并加载 `.cursor/skills/codefog/SKILL.md`），也可以手动通过 `@.cursor/skills/codefog/SKILL.md` 引用。
3. 发送指令，例如：
   > “用 codefog 对当前项目做代码质量评测，先给出评测结论，然后自动迭代优化测试直到 Trust Score 达到 85 分以上。”

### 3.2 在 Claude Code 中使用
1. 在项目根目录启动 `claude`。
2. Claude Code 会自动加载 `.claude/skills/codefog/SKILL.md`（或 `~/.claude/skills/codefog/SKILL.md`）。
3. 直接输入 `/codefog` 或使用自然语言指令：
   > “运行 codefog skill 评测当前仓库的代码与测试质量，给出诊断结论并持续优化高风险雾区，直到所有 fog-returned 清零且 Trust Score >= 80。”

### 3.3 在 Codex CLI 中使用
1. 启动 `codex`。
2. Codex 会自动扫描 `.codex/skills/codefog/SKILL.md` 与 `.agents/skills/codefog/SKILL.md`。
3. 输入指令：
   > “使用 $codefog 评测当前项目代码质量，输出评测结论，并按闭环流程持续优化测试直到达标。”

### 3.4 在 CodeBuddy 中使用
1. 打开 CodeBuddy Agent 会话。
2. CodeBuddy 会自动识别 `.codebuddy/skills/codefog/SKILL.md`。
3. 输入指令：
   > “请按照 codefog skill 对当前项目进行代码质量评测，给出结论后持续优化薄弱测试直到达标。”

---

## 4. 开箱即用的提示词（Prompt）模板库

你可以直接复制以下提示词发给 AI Agent：

### 模板一：全自动评测 + 持续迭代优化直到达标（最常用）
```text
请使用 codefog skill 对当前项目进行完整的代码质量与测试可信度评测：
1. 先运行覆盖率与 codefog 给出结构化评测结论（包含 Trust Score、五态分布、Top 高风险 Finding 根因分析）；
2. 以“清零全部 fog-returned 与伪测试方法，并将 Trust Score 提升至 >= 80”为目标，自动编写和强化包含实质结果断言（Outcome Assertions）的测试；
3. 每优化完一个文件必须运行 `codefog verify <file> --mutants` 进行反作弊变异验证，持续迭代直到达成目标，最后输出前后对比总结。
```

### 模板二：仅做深度代码质量体检与诊断结论（只读不改代码）
```text
请使用 codefog skill 对当前项目做一次只读的代码质量评测（不要修改任何代码）：
1. 生成最新覆盖率并运行 codefog 分析；
2. 向我输出完整的结构化评测结论：当前 Trust Score、五态代码行占比、哪些模块风险最高、哪些测试属于缺乏有效断言的“弱证据（weak-evidence）”或“伪测试（Pseudo-tested）”；
3. 按优先级列出排名前 5 的整改建议清单。
```

### 模板三：针对特定模块或核心目录定向攻坚
```text
请使用 codefog skill 评测当前项目，并重点针对 `internal/settlement`（或你指定的目录）进行定向优化：
先给出该模块当前的评测结论与高风险 Finding，然后逐个函数补强结果断言并通过 `codefog verify --mutants` 验收，直到该模块的 Trust Score 达到 90 以上。
```

### 模板四：PR 提交前增量自检与防退化闭环
```text
请使用 codefog skill，结合 `--diff origin/main` 检查我当前分支相比主干的增量代码质量：
如果存在新增的 `fog-returned`、`weakenedFiles` 或“覆盖率上升但有效证据下降（Coverage up, evidence down）”，请给出诊断结论并自动补齐实质断言，直到 `npx @barryzhu/codefog@latest --diff origin/main --fail-on regression` 及相关文件的 `codefog verify --mutants` 全部通过。
```

---

## 5. Skill 四阶段自动闭环工作流详解

当 AI Agent 加载 `codefog` Skill 后，它会严格遵循以下 4 个阶段执行，确保每一次优化都有据可查、真实有效：

```text
┌─────────────────────────────────────────────────────────────────────────┐
│ Step 1: 基线采集与扫描 (Run Baseline Evaluation)                         │
│   自动识别语言 (TS/JS, Go, Rust, Java) → 生成覆盖率 → 运行 codefog        │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ Step 2: 输出结构化评测结论 (Deliver Structured Evaluation Conclusion)     │
│   展示 Trust Score、五态 LOC 分布、Top Findings (CF-xxxx) 根因与收敛目标  │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ Step 3: 持续迭代优化与反作弊闭环 (Continuous Optimization Loop)   ◄──┐   │
│   3.1 按优先级挑取 agentReady 的目标；跳过自证雾与预期冲突                  │   │
│   3.2 编写/强化实质结果断言 (Outcome Assertions)，严禁删减生产代码分支      │   │
│   3.3 运行 `codefog verify <file> --mutants --lines <start>-<end>` 验收 │   │
│       ├─ 若存活变异体 > 0 或伪测试未拦截 → 继续补强测试断言               │   │
│       └─ 若 verify 通过 → 重新生成全仓覆盖率并运行 codefog 刷新评分 ───────┴───┘
│                           （未达标则继续下一轮迭代）
└───────────────────────────────────┬─────────────────────────────────────┘
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ Step 4: 最终收敛报告 (Final Convergence Report)                          │
│   输出优化前后指标对比表、已验证文件清单及 `.codefog/report.html` 路径     │
└─────────────────────────────────────────────────────────────────────────┘
```

### 关键阶段说明：

#### 阶段一：多语言基线自动采集
Skill 指导 Agent 自动识别项目技术栈并执行对应的覆盖率命令：
- **TypeScript / JavaScript**：`npx vitest run --coverage.enabled=true --coverage.reporter=lcov` 或 `npx jest --coverage --coverageReporters=lcov`
- **Go (`golang`)**：`go test -coverprofile=coverage.out ./...`
- **Rust**：`cargo llvm-cov --lcov --output-path coverage/lcov.info`
- **Java**：`mvn test jacoco:report` 或 `./gradlew test jacocoTestReport`

即使项目中暂时没有生成覆盖率文件，`codefog` 也会自动通过静态源码扫描生成全量 `Fog` 基线报告，绝不会报错中断。

#### 阶段二：结构化评测结论（先诊断，后动手）
Skill 要求 Agent 在修改任何测试前，必须先输出一份清晰的评测结论：
- **核心评分与五态分布**：
  - `fog-returned`（回雾，权重 `-0.5`）：生产代码改了运行时逻辑，但关联测试没跟进更新（最高危）；
  - `fog`（未知雾区，权重 `0.0`）：完全没有被任何测试执行过；
  - `self-proof-fog`（自证雾，权重 `+0.3`）：代码与测试在同一提交中生成，尚未经过变异测试证实；
  - `weak-evidence`（弱证据，权重 `+0.4`）：虽然行覆盖了，但只有非空/不报错检查（Liveness Check），或分支覆盖不全、存在存活变异体；
  - `verified`（已验证，权重 `+1.0`）：具备实质结果断言、分支全覆盖且测试新鲜。
- **Top Findings 根因诊断**：逐条列出 `[CF-xxxx] 文件:起止行 (函数名) | 状态 | 风险分`，并分析具体缺失了哪类业务断言。

#### 阶段三：反作弊网关 `codefog verify --mutants`
这是防止 AI 敷衍了事的核心机制。每当 Agent 为某个函数补完测试后，必须运行：

```bash
npx --yes @barryzhu/codefog@latest verify <targetFile> --mutants --lines <start>-<end>
```

`codefog verify` 会在后台自动执行四重反作弊检验：
1. **源码完整性保护**：检查目标生产文件是否被偷改或删减了条件分支；
2. **基线测试与断言检查**：确保测试通过且包含 AST 级别的结果断言；
3. **函数体零值清空（Body Clearance）**：把被测函数体替换成对应语言的默认零值（如 Go 的 `return 0, nil`、Rust 的 `Default::default()`、TS 的 `return undefined`、Java 的 `return null/0`）。如果清空函数体后测试居然还能通过，直接判定为 **`Pseudo-tested Method`（伪测试）** 并打回重改！
4. **算子翻转变异测试（Operator Mutations）**：对 `+`/`-`、`>`/`>=`、`&&`/`||`、`true`/`false` 进行合成变异，迫使 Agent 为边界条件和具体计算结果编写精确断言。

---

## 6. 实战演练：一次完整的 Agent 评测与迭代过程

以一个 Go 语言订单结算项目为例，当你对安装了 `codefog` Skill 的 AI Agent 说：
> **“用 codefog 评测当前项目并持续优化，直到 Trust Score >= 85”**

Agent 的执行轨迹如下：

1. **采集基线**：
   Agent 自动运行 `go test -coverprofile=coverage.out ./...` 与 `npx --yes @barryzhu/codefog@latest --fail-on none`。
2. **给出初始评测结论**：
   - 当前 **Trust Score**: `48/100`
   - 行覆盖率 `76.0%`，但检验覆盖率（`Checked Coverage`）仅 `32.0%`，伪测试方法数：`2`
   - 高优风险项：
     - `[CF-91A2] internal/order/settlement.go:18-64 (CalculateNetPayout) | fog-returned | risk 8.4` —— 最近修改了手续费封顶逻辑，但测试未更新。
     - `[CF-4B08] internal/order/refund.go:10-42 (EvaluateRefundWindow) | weak-evidence | risk 6.1` —— 测试中仅检查了 `if err != nil`，未断言退款金额与状态码。
3. **第 1 轮迭代（修复 `settlement.go`）**：
   - Agent 在 `settlement_test.go` 中补充了针对手续费封顶边界（`===` 与 `>` 临界值）及净结算金额的精确相等断言；
   - Agent 运行 `npx --yes @barryzhu/codefog@latest verify internal/order/settlement.go --mutants --lines 18-64`；
   - 第 1 次 `verify` 发现第 39 行 `>=` 变异为 `>` 时变异体存活；Agent 立即补充了刚好等于封顶阈值的测试用例，再次运行 `verify` 达到 **Mutation Score 100%，0 surviving mutants**。
4. **第 2 轮迭代（修复 `refund.go`）**：
   - Agent 将原有的存活性检查升级为对退款金额和拒绝原因的 `Outcome Assertion`，并通过 `codefog verify internal/order/refund.go --mutants` 验收。
5. **刷新全仓评分并输出最终报告**：
   - 重新运行 `go test -coverprofile=coverage.out ./... && npx --yes @barryzhu/codefog@latest`；
   - **Trust Score** 从 `48/100` 提升至 `91/100`，`fog-returned` 降为 `0`，伪测试方法数降为 `0`，自动结束循环并输出前后对比表。

---

## 7. 常见问题与排查（FAQ）

### Q1: 项目里还没有配置覆盖率输出，直接让 AI 运行这个 Skill 可以吗？
**可以。**
- 一方面，`codefog` Skill 内置了 TS/JS、Go、Rust、Java 四大语言的标准覆盖率生成命令，AI Agent 会自动尝试执行测试并生成覆盖率文件。
- 另一方面，即使环境中暂时无法运行测试或没有覆盖率文件，`codefog` 也会自动启用静态源码兜底扫描（将生产代码识别为 `Fog` 状态并计算复杂度与 Git 风险分），指导 Agent 从零开始建立测试。

### Q2: 为什么 AI 写完测试后，`codefog verify <file> --mutants` 提示失败？
这说明 AI 刚才写的测试没有通过**反作弊门禁**，常见原因有三种：
1. **修改或删减了生产源码**：`codefog verify` 默认禁止修改目标生产文件（防止通过删分支来提分）。如果确实属于合理的生产代码重构，需先提交代码或显式传入 `--allow-source-change`。
2. **伪测试（Body Clearance 未杀死）**：测试只断言了“不报错”或“返回值非空”，把函数体清空成默认零值后测试依然通过。此时 Agent 会根据报错自动补充对具体返回值的断言。
3. **存在存活变异体（Surviving Mutants）**：例如边界条件 `<` 变成 `<=` 时测试未失败。`codefog verify` 会打印出存活变异体的具体行号，Agent 会据此补充临界值用例。

### Q3: 如何在多语言混合仓库（Polyglot Monorepo）中使用？
`codefog` 原生支持在一次运行中聚合多份不同语言的覆盖率报告。在多语言仓库中，Agent 会自动使用重复的 `--coverage` 参数：
```bash
npx --yes @barryzhu/codefog@latest \
  --coverage coverage/lcov.info \
  --coverage services/pay/coverage.out \
  --coverage crates/core/lcov.info \
  --coverage java-sdk/target/site/jacoco/jacoco.xml
```
并且 `codefog verify <targetFile> --mutants` 会根据 `<targetFile>` 的文件后缀（`.ts`/`.js`、`.go`、`.rs`、`.java`）自动切换对应的变异器与测试运行命令。

### Q4: 如何更新已安装的 `codefog` Skill？
当 `@barryzhu/codefog` 发布新版本后，只需重新运行一次安装命令即可覆盖更新为最新版本的 `SKILL.md`：
```bash
npx @barryzhu/codefog@latest install-skill
# 或更新全局 Skill：
npx @barryzhu/codefog@latest install-skill --global
```
