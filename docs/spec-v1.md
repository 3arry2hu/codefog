# Codefog v1 规格说明（Specification）

> **一句话定位**：把仓库渲染成地图——有证据的地方退为背景，没验证过的是雾，证据失效后触发回雾告警。
> **对外标语**：*See which parts of your codebase you can actually trust.*

---

## 1. 目标与范围边界（Scope）

### 1.1 v1 交付范围（2–3 周可交付）
- **目标语言与生态**：仅限 TypeScript / JavaScript（Node.js >= 20，支持通过 `npx codefog` 直接运行）。
- **输入源**：
  - 必选：`lcov.info`（兼容 Vitest / Jest / c8 / Istanbul 标准 LCOV 输出）+ 本地 Git 仓库历史（`git log` / `git blame` / `git diff`）。
  - 可选：Stryker 变异测试报告（`reports/mutation/mutation.json`）。
- **核心交付物**：
  1. **CLI 扫描器与验收器**（`npx codefog` 与 `npx codefog verify`）
  2. **本地单文件交互式 HTML 雾图**（`.codefog/report.html`，支持四层渐进披露）
  3. **面向 AI Coding Agent 的结构化 JSON 输出**（`npx codefog --json`）
  4. **GitHub Action / PR 前后对比报告**（`npx codefog --diff <base> --pr-comment`，生成并排对比 SVG 与 Markdown 摘要）

### 1.2 明确不做（Non-Goals for v1）
- 不支持多语言（Python / Go / Rust / Java 等不在 v1 范围）。
- 不构建托管云服务或数据库后端（纯本地/CI 零状态或基于仓库文件运行）。
- CLI 内部不内嵌 LLM 调用（通过确定性算法产出结构化 `Finding` 供外部 AI Agent 消费）。

---

## 2. 核心领域模型与判定规则

术语严格遵循仓库根目录 `GLOSSARY.md` 定义：

### 2.1 五态证据模型（Evidence States）

按紧急度从高到低排序：

| 状态 | 标识值 (`state`) | 色值（浅色主题） | 双重编码 | 判定规则 |
| :--- | :--- | :--- | :--- | :--- |
| **Fog Returned（回雾）** | `fog-returned` | `#BD4900`（实心警示橙，白字 `#FFFFFF`） | `RETURNED` 标签 | 1. **证据过期**：代码块最新非纯格式/注释/类型变更时间晚于覆盖率/变异报告生成时间；或<br>2. **验证降级**：对比基准（`--diff` 或 baseline）中曾为 `verified`，修改后降级为 `fog` / `weak-evidence` / `self-proof-fog`。 |
| **Fog（雾）** | `fog` | `#1D3656`（深石板蓝，白字 `#FFFFFF`） | 纯色深块 | `lcov.info` 中行覆盖率为 0（从未被任何测试执行）。 |
| **Self-proof Fog（自证雾）** | `self-proof-fog` | `#6E88AA`（中石板蓝） | 45° 斜纹填充 | 代码块被测试执行且有断言，但 Git blame 显示被测实现与其唯一关联测试断言在同一次 commit（或同一 PR 分支增量）中产生，且尚未通过变异/伪测试检验。 |
| **Weak Evidence（弱证据）** | `weak-evidence` | `#BCCCE2`（浅石板蓝） | 浅底深字 | 代码块被测试执行，但满足任一：<br>1. 关联测试无实质断言（0 断言或仅 `toBeDefined`/`toBeTruthy` 等弱断言）；<br>2. 分支覆盖率 < 100%；<br>3. 存在 `Surviving Mutant` 或属于 `Pseudo-tested Method`。 |
| **Verified（已验证）** | `verified` | `#EBEFF4`（极浅灰背景，标签 `#8B96A5`） | 折叠/弱化 | 代码块被执行、分支覆盖完整、测试返回值/状态流入有效断言（`Checked Coverage`），或通过变异测试（无存活变异体），且证据未过期。 |

> **AST 降噪规则**：计算 `Freshness`（新鲜度）与 `Fog Returned` 时，通过 TypeScript AST 归一化比对忽略纯注释、空白格式化以及纯类型声明（`type` / `interface`）变更。

### 2.2 核心度量计算（Metrics & Scores）

1. **Checked Coverage（检验覆盖）**：
   - 基于 `lcov.info` 已执行行 + TS AST 静态数据流分析：仅当测试文件中调用被测函数后的返回值、对象变更或异常流入有效 `expect(...)` / `assert(...)` 断言语句时，对应被测函数的已执行行才计入 `Checked Coverage`。
2. **Pseudo-tested Method（伪测试方法）**：
   - 被测试执行过，但静态分析显示其输出未被任何断言消费，或在 `verify` 阶段清空函数体/返回默认值后所有关联测试依然通过的函数。
3. **Trust Score（信任分，0–100）**：
   - 按有效代码行数（LOC）加权聚合：
     $$\text{Trust Score} = \text{clamp}\left(0, 100, \text{round}\left(\frac{1.0 \cdot \text{LOC}_{\text{verified}} + 0.4 \cdot \text{LOC}_{\text{weak}} + 0.3 \cdot \text{LOC}_{\text{self}} - 0.5 \cdot \text{LOC}_{\text{returned}}}{\text{LOC}_{\text{total}}} \times 100\right)\right)$$
4. **Risk Score（风险分，0.0–10.0）**：
   - 用于文件块与 `Finding` 的排序：
     $$\text{Raw Risk} = \ln(1 + \text{Unverified LOC}) \times \ln(1 + \text{Git Churn}_{90d}) \times \ln(1 + \text{Cyclomatic Complexity}) \times W_{\text{state}}$$
   - 状态权重 $W_{\text{state}}$：`fog-returned = 2.0`，`fog = 1.4`，`self-proof-fog = 1.2`，`weak-evidence = 1.0`，`verified = 0.0`；最终对数归一化到 `0.0–10.0`（保留 1 位小数）。

---

## 3. CLI 接口契约（CLI Surface）

### 3.1 主扫描命令：`npx codefog [root-dir]`

```bash
npx codefog [root-dir] [options]
```

- `--lcov <path>`：指定 LCOV 覆盖率文件路径（默认自动探测 `coverage/lcov.info`）。
- `--stryker <path>`：可选，导入 Stryker 变异报告（默认探测 `reports/mutation/mutation.json`）。
- `--json`：向 `stdout` 输出完整 JSON 结构化报告（符合下方第 5 节 JSON Schema）。
- `--html <path>`：生成单文件自包含交互式四层 `Fog Map`（默认 `.codefog/report.html`），配合 `--open` 自动在浏览器打开。
- `--diff <base-ref>`：对比指定 Git 基准（如 `main`），计算五项核心指标变化量并识别增量 `Fog Returned`。
- `--pr-comment <dir>`：配合 `--diff` 使用，输出 PR 评论用的 `.codefog/pr-diff.svg`（并排 BEFORE/AFTER Treemap）与 `.codefog/pr-comment.md`。
- `--fail-on <policy>`：退出码策略，可选 `returned`（默认，存在 `fog-returned` 时退出码为 `1`）、`any-fog`、`regression`、`none`。

### 3.2 定点验收命令：`npx codefog verify <target>`

```bash
npx codefog verify <file-or-finding-id> [options]
```

- `--mutants`：对目标文件（或指定行区间 `--lines <start>-<end>`）执行定点变异测试（如边界条件 `>` ↔ `>=`、`===` ↔ `!==`、逻辑分支反转）与伪测试方法检测（函数体清空检验）。
- `--test-cmd <cmd>`：自定义测试运行命令（默认自动探测 `vitest run` / `jest` / `node --test` 并仅运行依赖该文件的关联测试）。
- `--allow-source-change`：默认关闭；默认强制校验被测业务源码的 AST 分支结构未被删减。

**`verify` 防刷分三项硬门禁（全部通过才返回退出码 `0`）**：
1. **变异体杀死门禁**：目标行区间的注入变异体必须被测试杀死（测试失败），伪测试方法清空后测试必须失败。
2. **源码防篡改门禁**：除非传入 `--allow-source-change`，被测业务函数签名与控制流分支不得减少（防止 Agent 通过删除业务分支消除未覆盖代码）。
3. **测试断言质量门禁**：新增或修改的测试必须包含针对目标返回/状态的实质性断言，拒绝 0 断言或纯 `toBeDefined()` 敷衍测试。

---

## 4. 四层渐进披露视图（Fog Map UI）规格

生成的 `.codefog/report.html` 采用暖白浅色主题（背景 `#F8F9FA` / `#FFFFFF`），包含四个可钻取层级：

1. **Level 1 - Repository（仓库总览）**：
   - 顶部指标卡：`Trust Score`（0–100）、总文件数与 LOC、`Fog` 占比、`Fog Returned` 影响单元数。
   - 左侧/主区：`Top Fog Hotspots`（按 `Risk Score` Top 10 排列的高危文件）+ `Modules by Fog`（按未验证比例排序的顶层目录横条图）。
2. **Level 2 - Module（模块/目录视图）**：
   - 展示选定模块下的子目录列表，带有状态比例横条与 `RETURNED` / `FOG` 标签；完全 `Verified` 的子目录自动折叠为底部单行（如 `Collapsed: 14 verified subdirectories`）。
3. **Level 3 - File Map（文件树图 Treemap）**：
   - 矩形面积映射代码行数（或风险加权 LOC），颜色严格采用五态色板；
   - 当前目录下所有 `Verified` 文件自动折叠到右侧浅灰静音区（如 `Verified · 32 files`），让 `Fog Returned`（橙色）与 `Fog`（深石板蓝）占据核心视野。
4. **Level 4 - Code & Finding（代码与待办详情）**：
   - 左侧：当前文件内的 `Findings` 列表（如 `CF-1182 refund branch (9.4)`）。
   - 中间：源码行视图，高亮未验证行区间，并在存活变异体行下内联标注（如 `Surviving mutant > → >= on line 46 · all 14 tests still pass`）。
   - 右侧：结构化 `Finding` 详情卡片（状态标签、问题类型、Evidence、Suggested Action、Acceptance Check 命令 `npx codefog verify ...`）及一键复制 Agent 任务的 `Copy as task for agent` 按钮。

---

## 5. JSON Schema 与样例输出（`npx codefog --json`）

```json
{
  "$schema": "https://codefog.dev/schemas/v1/report.json",
  "version": "1.0.0",
  "repository": {
    "name": "acme-shop",
    "branch": "main",
    "commit": "3f9c2e1",
    "generatedAt": "2026-10-19T15:30:00Z",
    "baseRef": "origin/main"
  },
  "summary": {
    "trustScore": 68,
    "totalFiles": 128,
    "totalLoc": 14250,
    "metrics": {
      "lineCoveragePct": 79.0,
      "branchCoveragePct": 63.5,
      "checkedCoveragePct": 44.0,
      "mutationScorePct": 39.2,
      "pseudoTestedMethods": 14
    },
    "locByState": {
      "fog-returned": 310,
      "fog": 2680,
      "self-proof-fog": 850,
      "weak-evidence": 2120,
      "verified": 8290
    }
  },
  "modules": [
    {
      "path": "src/billing",
      "totalFiles": 18,
      "verifiedFilesCollapsed": 11,
      "trustScore": 52,
      "maxRiskScore": 9.4,
      "locByState": {
        "fog-returned": 180,
        "fog": 620,
        "self-proof-fog": 140,
        "weak-evidence": 390,
        "verified": 1120
      }
    }
  ],
  "findings": [
    {
      "id": "CF-1182",
      "title": "refund branch",
      "state": "fog-returned",
      "riskScore": 9.4,
      "agentReady": true,
      "location": {
        "file": "src/billing/stripe/webhook/handler.ts",
        "symbol": "handleChargeRefunded",
        "startLine": 44,
        "endLine": 50
      },
      "reason": "Fog returned — refund branch changed in a1c09e7, 2 days after verification.",
      "evidence": {
        "executedByTests": 3,
        "assertionsOnOutcome": 0,
        "pseudoTested": false,
        "survivingMutants": [
          {
            "id": "mut-46-gt-gte",
            "line": 46,
            "original": "if (amount > order.total)",
            "mutated": "if (amount >= order.total)",
            "testsRun": 14,
            "killed": false
          }
        ]
      },
      "suggestedAction": "Add a test for a refund larger than the order total, asserting markPartial is returned and ledger is not credited.",
      "acceptanceCheck": {
        "command": "npx codefog verify src/billing/stripe/webhook/handler.ts --mutants --lines 44-50",
        "criteria": [
          "Mutant mut-46-gt-gte on line 46 is killed",
          "Lines 44-50 reach verified state with at least 1 outcome assertion"
        ]
      }
    }
  ]
}
```
