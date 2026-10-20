# codefog (`@barryzhu/codefog`)

**See which parts of your codebase you can actually trust.**

`codefog` 是一款面向 **TypeScript / JavaScript、Go、Rust、Java** 及多语言混合仓库（Polyglot Monorepo）的“雾优先（Fog-first）”代码信任与风险分析工具。它结合覆盖率数据、静态语法调用图与断言分析、Git 演进历史以及变异测试结果，将代码库划分为五种证据状态，定位缺乏有效断言的“伪覆盖”与代码修改后测试失效的“回雾（Fog Returned）”区域，并为开发者与 AI 编码代理提供可自动验收的修复目标（`Finding`）。

---

## 核心概念：五态证据模型（Five-State Evidence Model）

传统覆盖率工具只统计“代码行是否被执行过”，容易将没有实质断言的冒烟测试误判为安全（绿灯）。`codefog` 采用**雾优先视觉模型**，将已验证代码退化为浅灰背景，突出展示未验证与信任退化区域：

| 状态 (`EvidenceState`) | 名称 | 判定条件 | 视觉色值 | Trust 权重 | Risk 权重 |
| :--- | :--- | :--- | :--- | :---: | :---: |
| `fog-returned` | **回雾（雾回归）** | 曾被测试覆盖，但最近一次**运行时逻辑修改**晚于关联测试修改（注释/文档/纯类型修改不触发） | `#BD4900`（警示橙） | `-0.5` | `2.0` |
| `fog` | **雾（未知区）** | 没有任何测试执行或覆盖证据的代码区域 | `#1D3656`（深石板蓝） | `0.0` | `1.4` |
| `self-proof-fog` | **自证雾** | 生产代码与其唯一测试在同一次 Git 提交中诞生，且尚未经过独立变异测试证实 | `#6E88AA`（斜纹灰蓝） | `+0.3` | `1.2` |
| `weak-evidence` | **弱证据** | 已被测试执行，但仅有存活性检查（Liveness Check，无结果断言）、分支覆盖不全（`< 100%`）或存在存活变异体 | `#BCCCE2`（浅石板蓝） | `+0.4` | `1.0` |
| `verified` | **已验证** | 具备实质结果断言（Outcome Assertion）、分支完整覆盖、无存活变异体且测试证据相对最新代码改动保持新鲜 | `#EBEFF4`（极浅灰背景） | `+1.0` | `0.0` |

> 完整领域术语定义见 [`GLOSSARY.md`](./GLOSSARY.md)，架构设计决策见 [`docs/adr/`](./docs/adr/)。

---

## 多语言支持矩阵（Polyglot Support）

`codefog` 内置零外部二进制依赖的多语言适配器（`LanguageAdapter`），无需在宿主机安装额外 WASM 或语言插件即可分析单语言或多语言混合仓库：

| 维度 | TypeScript / JavaScript | Go (`golang`) | Rust | Java |
| :--- | :--- | :--- | :--- | :--- |
| **生产源码识别** | `.ts`, `.tsx`, `.js`, `.jsx` | `.go`（排除 `*_test.go`） | `.rs`（自动剥离同文件 `#[cfg(test)]` 模块） | `.java`（`src/main/java/**`） |
| **覆盖率格式（自动探测）** | LCOV (`coverage/lcov.info`) | Go `coverprofile` (`coverage.out`) + `go.mod` 路径归一化 | LCOV (`cargo llvm-cov --lcov`) | JaCoCo XML (`jacoco.xml`) 或 LCOV |
| **结果断言 (`Outcome Assertion`)** | `expect(x).toBe(y)`, `toEqual`, `toThrow` 等 | `t.Errorf`/`Fatalf` 具体值比较、`reflect.DeepEqual`、`cmp.Diff`、`assert.Equal` | `assert_eq!`, `assert_ne!`, `matches!`, `#[should_panic(expected = "...")]` | JUnit 5 `assertEquals`/`assertThrows`, AssertJ `assertThat(x).isEqualTo(y)` |
| **存活性检查 (`Liveness Check`)** | `toBeDefined()`, `toBeTruthy()`, `not.toThrow()` | `err == nil`, `res != nil`, `require.NoError(t, err)` | `.unwrap()`, `.expect()`, `assert!(res.is_ok())`, `assert!(opt.is_some())` | `assertNotNull(x)`, `assertTrue(opt.isPresent())`, `isNotNull()` |
| **Git 新鲜度去噪** | 忽略注释与纯 `type` / `interface` 变更 | 忽略 GoDoc / 行注释与 `import` 变更 | 忽略 `//`、`///` 文档注释，支持**同文件**生产函数与 `#[cfg(test)]` 独立演进比对 | 忽略 Javadoc、行注释与方法注解变更 |
| **外部变异报告 (`--mutation-report`)** | Stryker JSON (`mutation.json`) | 内置 `codefog verify` 引擎 | `cargo-mutants` (`mutants.out/outcomes.json`) | PITest XML (`mutations.xml`) |
| **闭环变异验证 (`codefog verify`)** | `npx vitest run` | `go test ./...`（多返回值零值变异 + 编译错误豁免） | `cargo test`（`Default::default()` / `Ok` 变异 + 编译错误豁免） | `mvn test` / `./gradlew test`（类型安全默认返回值变异） |

---

## 快速开始（Quick Start）

### 1. 安装与运行

无需全局安装，直接在任意 Git 仓库根目录运行：

```bash
# 自动探测仓库内的覆盖率与变异测试报告，生成 .codefog/report.html 并在终端打印摘要
npx @barryzhu/codefog
```

或者作为项目开发依赖安装：

```bash
npm install -D @barryzhu/codefog
```

### 2. 各语言使用示例

**TypeScript / JavaScript (Vitest / Jest + Stryker)**

```bash
vitest run --coverage.enabled=true --coverage.reporter=lcov
npx @barryzhu/codefog --coverage coverage/lcov.info --mutation-report reports/mutation/mutation.json
```

**Go**

```bash
go test -coverprofile=coverage.out ./...
npx @barryzhu/codefog --coverage coverage.out
```

**Rust**

```bash
cargo llvm-cov --lcov --output-path coverage/lcov.info
npx @barryzhu/codefog --coverage coverage/lcov.info --mutation-report mutants.out/outcomes.json
```

**Java (Maven / Gradle + JaCoCo + PITest)**

```bash
mvn test jacoco:report
npx @barryzhu/codefog --coverage target/site/jacoco/jacoco.xml --mutation-report target/pit-reports/mutations.xml
```

**多语言混合仓库（Polyglot Monorepo）**

`--coverage` 支持重复传参或逗号分隔，自动将多套覆盖率报告聚合为统一的仓库级 `CodefogReport`：

```bash
npx @barryzhu/codefog \
  --coverage coverage/lcov.info \
  --coverage services/billing/coverage.out \
  --coverage crates/engine/lcov.info \
  --coverage java-core/target/site/jacoco/jacoco.xml
```

### 3. 终端输出示例（Level 1 Summary）

```text
codefog | payment-service (main @ 64c2ba2)
Trust Score: 74/100 | Files: 12 | LOC: 840 | Unverified (Fog): 26%
Metrics: Line 88.5% | Branch 79.2% | Checked 71.4% | Mutation 82.0% | Pseudo-tested: 1
States: Returned=18 Fog=92 Self-proof=34 Weak=74 Verified=622

Modules by Fog:
  - internal/settlement: Trust 58/100 | Risk 7.8 | Fog=42 Weak=30 Verified=110
  - src/core: Trust 86/100 | Risk 4.1 | Fog=12 Weak=18 Verified=320

Top Fog Hotspots & Findings:
  - [CF-8A2F] internal/settlement/ledger.go:42-89 (ReconcileBatch) | fog-returned | risk 7.8
  - [CF-3C19] src/core/discount.ts:15-48 (calculateTierDiscount) | weak-evidence | risk 5.4
```

---

## CLI 命令与参数说明

### `codefog [rootDir] [options]`

分析目标仓库并输出信任地图与发现项列表。

| 参数 | 说明 | 默认值 |
| :--- | :--- | :--- |
| `--coverage <path>` | 覆盖率文件路径（支持 LCOV、Go `coverprofile`、JaCoCo XML；可重复传参或逗号分隔） | 自动探测 `coverage/lcov.info`、`coverage.out`、`target/site/jacoco/jacoco.xml` 等 |
| `--lcov <path>` | `--coverage` 的别名（向下兼容） | 同上 |
| `--mutation-report <path>` | 外部变异测试报告路径（支持 Stryker JSON、PITest XML、`cargo-mutants` JSON） | 自动探测标准产出路径 |
| `--stryker <path>` | `--mutation-report` 的别名（向下兼容） | 同上 |
| `--diff <baseRef>` | 与指定 Git 基准分支/提交（如 `origin/main`）进行增量对比，检测信任退化 | 无 |
| `--pr-comment [dir]` | 生成 PR 增量对比评论制品（`pr-comment.md` 与 `pr-diff.svg`） | `.codefog` |
| `--html <path>` | 交互式单文件 HTML 雾图输出路径 | `.codefog/report.html` |
| `--open` | 生成报告后在系统默认浏览器中打开 HTML 雾图 | `false` |
| `--json` | 将完整 `CodefogReport` JSON 结构输出至标准输出 (`stdout`) | `false` |
| `--fail-on <policy>` | CI 退出码门禁策略：`returned` \| `regression` \| `any-fog` \| `none` | `returned` |
| `-v, --version` | 打印版本号 | - |
| `-h, --help` | 打印帮助信息 | - |

#### `--fail-on` 门禁策略说明
- `returned`（默认）：当仓库中存在任何 `fog-returned`（代码逻辑已改但测试未跟进）时返回退出码 `1`。
- `regression`：当存在 `fog-returned`、在 `--diff` 下存在证据降级文件（`weakenedFiles`），或出现“行覆盖率上升但有效证据下降（`coverageUpEvidenceDown`）”时返回退出码 `1`。
- `any-fog`：最严格门禁，只要存在任何非 `verified` 状态的代码行即返回退出码 `1`。
- `none`：始终返回 `0`（仅生成报告，不阻断 CI）。

---

### `codefog verify <targetFile> [options]`

面向开发者与 AI 编码代理的**单文件反作弊验收网关**。在补齐某个 `Finding` 的测试后，运行该命令对目标文件执行轻量级合成变异验证，确保新增测试包含真正的业务结果断言，而非删减生产分支或编写无断言的伪测试。

```bash
npx @barryzhu/codefog verify src/pricing.ts --lines 10-45 --mutants
npx @barryzhu/codefog verify internal/tax/calc.go --mutants --test-cmd "go test ./..."
```

| 参数 | 说明 |
| :--- | :--- |
| `<targetFile>` | 待验收的目标源码文件路径（支持 `.ts`/`.js`、`.go`、`.rs`、`.java`） |
| `--lines <start-end>` | 仅针对指定行号区间内的函数生成并执行变异验证 |
| `--mutants` | 启用合成变异测试（含条件/算子翻转与函数体零值清空检测） |
| `--test-cmd <cmd>` | 自定义测试执行命令（未指定时按文件后缀自动选择 `vitest` / `go test` / `cargo test` / `mvn test`） |
| `--allow-source-change` | 允许在目标生产文件相比 `HEAD` 存在未提交改动时执行验证（默认禁止通过删减生产代码分支来消除雾区） |

**反作弊检查项（Anti-Gaming Gates）**：
1. **生产源码保护**：默认拒绝修改被测生产源码或减少条件分支数（防止通过删除业务分支来凑满覆盖率）。
2. **基线测试通过**：变异前现有测试套件必须通过，且测试文件中必须包含实质性断言。
3. **伪测试拦截（Body Clearance）**：将目标函数体替换为对应语言的零值返回后，测试套件**必须失败**，否则判定为 `Pseudo-tested Method`。
4. **算子变异击杀（Operator Mutations）**：注入算术、比较与布尔翻转等变异后，计算有效变异得分（静态类型语言下无法编译的合成变异标记为 `CompileError` 并自动从分母中豁免）。

---

## 度量指标与计算公式（Metrics & Scoring）

### 1. Trust Score（信任分，`0` – `100`）
反映仓库、模块或文件的有效证据健康度：

\[
\text{Trust Score} = \text{clamp}_{[0, 100]}\left(\text{round}\left(\frac{1.0 \cdot L_{\text{verified}} + 0.4 \cdot L_{\text{weak}} + 0.3 \cdot L_{\text{self-proof}} - 0.5 \cdot L_{\text{returned}}}{L_{\text{total}}} \times 100\right)\right)
\]

### 2. Risk Score（风险分，`0.0` – `10.0`）
衡量单个文件或 `Finding` 的修复紧迫度，综合未验证代码行数（\(L_{\text{unverified}}\)）、近 90 天 Git 修改次数（\(\text{Churn}_{90d}\)）、圈复杂度（\(\text{CC}\)）与状态权重（\(W_{\text{state}}\)）：

\[
R_{\text{raw}} = \ln(1 + \max(1, L_{\text{unverified}})) \times \ln(1 + \max(1, \text{Churn}_{90d})) \times \ln(1 + \max(1, \text{CC})) \times W_{\text{state}}
\]

\[
\text{Risk Score} = \text{round}_{0.1}\left(\min\left(10.0, \max\left(0.1, \frac{R_{\text{raw}}}{R_{\text{raw}} + 3.5} \times 10\right)\right)\right)
\]

### 3. 核心辅助指标
- **Checked Coverage（检验覆盖率）**：被测试执行且关联至少一个 `Outcome Assertion`（且未处于 `fog-returned`）的代码行占总可执行行的比例。
- **Pseudo-tested Methods（伪测试方法数）**：被测试执行过，但没有任何结果断言或清空函数体后测试依然全部通过的方法数量。

---

## 交互式 HTML 雾图与 PR 增量报告

### 四层渐进披露 HTML 雾图（`.codefog/report.html`）
运行 `codefog` 默认生成的单文件自包含 HTML 报告（零外部 CDN 依赖，可离线打开或作为 CI Artifact 归档）：
- **Level 1（仓库总览）**：展示 `Trust Score`、五态比例条、核心指标卡片与 Top 5 高风险 `Finding`。
- **Level 2（模块摘要）**：按模块（如 `src/*`、`internal/*`、`crates/*`、`src/main/java`）汇总状态分布，自动折叠 100% `verified` 的安全文件。
- **Level 3（文件树图 Treemap）**：面积编码代码规模（LOC），颜色与纹理编码五态证据状态。
- **Level 4（源码行级审查与 Agent 复制）**：逐行高亮证据状态、存活变异体详情，并提供一键复制给 AI Agent 的修复指令与验收命令。

### PR 增量对比与评论制品（`--diff` & `--pr-comment`）

```bash
npx @barryzhu/codefog --diff origin/main --pr-comment .codefog --fail-on regression
```

- **`.codefog/pr-comment.md`**：可直接发布到 GitHub Pull Request 的 Markdown 报告，包含 `Trust Score` 前后对比、新增 `fog-returned` 文件列表以及 **"Coverage Up, Evidence Down"（覆盖率上升但有效证据下降）** 预警。
- **`.codefog/pr-diff.svg`**：Before / After 证据状态对比矢量图。

---

## 编程接口（Programmatic API）

`@barryzhu/codefog` 提供完整的 ESM TypeScript API：

```typescript
import {
  analyzeRepository,
  verifyTargetWithMutants,
  writeHtmlFogMap,
} from "@barryzhu/codefog";

// 1. 运行仓库级多语言信任分析
const report = await analyzeRepository({
  rootDir: process.cwd(),
  coveragePath: ["coverage/lcov.info", "coverage.out"],
  mutationReportPath: "mutants.out/outcomes.json",
  diffBase: "origin/main",
});

console.log(`Trust Score: ${report.summary.trustScore}/100`);

// 2. 生成交互式 HTML 雾图
await writeHtmlFogMap(process.cwd(), report, ".codefog/report.html");

// 3. 运行单文件合成变异验证
const verifyResult = await verifyTargetWithMutants({
  rootDir: process.cwd(),
  targetFile: "src/analyzer.ts",
  mutants: true,
});
console.log(verifyResult.passed, verifyResult.summary);
```

---

## 本地开发与自举验证（Dogfooding）

环境要求：**Node.js >= 20.0.0**。

```bash
# 安装依赖
npm install

# 运行全量测试套件（涵盖 TS/JS、Go、Rust、Java 端到端测试）
npm test

# TypeScript 类型检查与构建
npm run typecheck
npm run build

# 使用 codefog 分析自身代码库（自举验证）
npm run dogfood
```

## License

[MIT](./package.json)
