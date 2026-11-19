# 调研与方案评估：面向“代码腐化”与“架构腐化”的 codefog 演进路线

> 调研日期：2026-11-19。本文在 [`docs/research/code-and-doc-rot.md`](./code-and-doc-rot.md)（侧重文档腐化）的基础上，补充代码腐化与架构腐化领域的一手学术论文、2025–2026 AI 编程时代实证研究及主流工程工具调研，并结合 `codefog` 当前定位（ADR-0001 至 ADR-0006）对四条演进方案进行评估。所有事实性陈述均附一手来源链接；标注 **【建议】** 的段落为作者对 `codefog` 的工程判断。

---

## TL;DR

- **AI 编程让代码与架构腐化加速且呈现结构性特征**：多项 2025–2026 因果与大规模实证研究表明，AI 编程工具带来的产出提速往往在 1–2 个月内衰减，但**代码复杂度（+39%–41%）与静态分析告警（+18%–30%）持续累积**（[He et al. 2025](https://arxiv.org/abs/2511.04427)；[Agarwal et al. MSR 2026](https://arxiv.org/html/2601.13597)）；重构/移动行占比从 2022 年的 21% 降至 2026 年的 3.8%，而块级代码复制上升 81%、错误吞咽上升 47%（[GitClear 2026](https://www.gitclear.com/the_ai_code_quality_maintainability_gap)）。
- **“仅靠文档/提示词管不住架构漂移”已有实证**：在真实万星仓库的 1,779 次提交分析中，即便 `AGENTS.md` 明文写下了分层禁令，违规跨层导入仍持续合入；LLM 自我反思甚至让架构合规率从 67% 降至 50%，向小模型提供架构上下文还可能因“路径提示启动效应”导致合规率倒退。**只有不可绕过的确定性可执行门禁**才能把合入合规率稳定在 100%（[Yergattikar, GroundLM 2026](https://aclanthology.org/2026.groundlm-1.76.pdf)）。
- **警惕“分母稀释错觉”**：一项针对 151 个 Java 仓库的因果研究发现，AI 导致代码行数（LOC）增长 12.8% 而架构坏味道总数几乎不变（+1.1%），从而让“单位千行坏味道密度”表面下降 6.7%（[arXiv:2606.13298](https://arxiv.org/pdf/2606.13298v1.pdf)）。反腐化指标必须看**绝对增量与 PR diff 净增违规**，不能只看按 LOC 归一化的密度。
- **最有效的架构腐化检测结合了“静态依赖 + Git 演化历史”**：经典研究与工程实践证明，仅靠静态规则抓不到隐式耦合；将静态依赖矩阵与 Git 共变（Change Coupling）交叉分析，可精准定位四大高缺陷成本架构反模式——不稳定接口、模块化违背（无静态导入却高频共变）、循环依赖、不当继承（[Wong et al. ICSE 2011](https://doi.org/10.1145/1985793.1985850)；[Cai & Kazman 2016](https://dl.acm.org/doi/pdf/10.1145/2896935.2896940)；[DV8](https://par.nsf.gov/servlets/purl/10194572)；[CodeScene](https://codescene.com/blog/change-coupling-visualize-the-cost-of-change)）。
- **【建议】`codefog` 的差异化切入点（方案 C）**：不要把 `codefog` 做成大而全的传统 Linter（SonarQube / Qlty）或重型字节码架构平台（Sonargraph / Teamscale）。守住 **ADR-0001 雾优先五态语义**与 **ADR-0003 零二进制多语言底盘**，用“**代码演化复杂度增量 + 零配置静态/共变架构健康图 + 轻量可执行边界契约**”三条支柱，做出市面上独一无二的**“信任证据 × 架构稳健度 × Git 演化”交叉雷达与不可绕过的 Agent 验收闭环**。

---

## 1. 代码层腐化（Code Rot）：AI 时代的实证与关键度量

### 1.1 2025–2026 实证研究汇总

| 研究 | 样本与方法 | 核心量化发现 | 对反腐化工具的启示 |
| :--- | :--- | :--- | :--- |
| [Tornhill & Borg, *Code Red* (arXiv:2203.04374)](https://arxiv.org/pdf/2203.04374) | 39 个商业生产代码库，CodeScene Code Health | 处于 Alert（< 4.0）级别的代码，问题解决耗时比健康代码**长 124%**，且交付周期极不可预测；技术债消耗高达 42% 研发时间。 | 代码腐化的业务成本主要集中在少数低健康度热点，而非均匀分布。 |
| [He et al., *Does AI-Assisted Coding Deliver?* (arXiv:2511.04427)](https://arxiv.org/html/2511.04427v2) | 806 个采用 Cursor 的 GitHub 项目 vs 匹配对照组，双重差分（DiD）+ 面板 GMM | 产出增速在首月飙升 3–5×，但 **2 个月后消退**；**静态分析告警持续上升 29.7%、代码复杂度持续上升 40.7%**。动态面板估算：复杂度每增 100% 导致后续产出下降 64.5%。 | 速度红利会迅速被累积的复杂度债吃掉，质量门禁必须与 AI 生成同步前置。 |
| [Agarwal, He & Vasilescu (MSR 2026 / arXiv:2601.13597)](https://arxiv.org/html/2601.13597) | AIDev 自主 Coding Agent 数据集，交错 DiD | 自主 Agent 导致**静态告警上升约 18%、认知复杂度上升约 39%**（Agent-first 仓库 5 个月内升至约 +49%）。 | 认知复杂度（而非仅行覆盖率）是 Agent 代码腐化的最敏感领先指标。 |
| [GitClear *AI Code Quality Research* (2025 / 2026)](https://www.gitclear.com/the_ai_code_quality_maintainability_gap) | 2023–2026 年 6.23 亿行变更（2025 版为 2.11 亿行） | 重构/移动行占比从 2022 年 21% 降至 2026 年 3.8%；单次提交内复制粘贴从 9.4% 升至 15.7%；**块级重复上升 81%、错误吞咽（error-masking）上升 47%、两周返工率（churn）上升 15%、跨文件复用调用下降 35%**。 | 需警惕：占比变化受总代码量增长影响且相关不等于因果（[Big Agile 评述](https://big-agile.com/blog/ai-technical-debt-refactoring)），但“复制代替复用 + 吞掉错误”是极清晰的可检测信号。 |

### 1.2 哪些代码腐化指标值得内置，哪些应交给外部工具？

1. **认知复杂度（Cognitive Complexity）优于单独使用圈复杂度（Cyclomatic Complexity）**
   - SonarSource 白皮书明确区分两者：圈复杂度按数学图论统计控制流路径数，适合衡量**可测试性（需要多少测试用例）**；认知复杂度按人类阅读时的心智负担计分（打断线性流 +1、嵌套每深一层额外叠加惩罚、可读简写不扣分），才真正衡量**可理解性与维护成本**（[Campbell 2023, v1.7](https://www.sonarsource.com/docs/CognitiveComplexity.pdf)）。
   - **【建议】** `codefog` 已有圈复杂度，正好服务于测试覆盖与 `Risk Score`；若面向抗腐化，增加**认知复杂度**与**最大嵌套深度**能准确抓出“测试全绿但人类与 AI 根本读不懂”的深层嵌套函数。

2. **“变更频率 × 复杂度”热点与短期返工（Short-term Churn）**
   - 长期不改的复杂老代码不产生利息；频繁修改（90d churn）且高复杂度的文件才是真正的演化热点（[CodeScene 术语](https://codescene.io/docs/terminology/codescene-terminology.html)）。
   - 14 天内的短期返工（写完两周内被反复修改/回滚）是代码设计不稳或 AI 补丁未一次到位的直接信号（[GitClear 2026](https://www.gitclear.com/the_ai_code_quality_maintainability_gap)）。

3. **AI 时代高发、低误报的局部腐化模式**
   - **错误吞咽（Error-Masking）**：如 TS/JS 空 `catch {}`、Go 显式丢弃错误或空 `if err != nil {}`、Rust 生产代码泛滥 `.unwrap()` / 丢弃 `let _ = ...`、Java 空 `catch` 块。这类模式往往同时伴随未测异常路径，与 `codefog` 的证据视角高度重合。
   - **PR 增量块级复制（Diff Block Duplication）**：相比全仓重型克隆检索引擎，在 `--diff` 对比时检查“本次 PR 新增的重复逻辑块”计算极轻且直指 AI “复制代替复用”的痛点。

4. **应继续通过 SARIF / Knip 外部集成的能力**
   - 风格格式化（Prettier / Biome / gofmt / rustfmt）、数百条语言特化 lint（ESLint / Clippy / golangci-lint）、深度安全污点分析（CodeQL / Semgrep）以及跨框架入口点的精确死代码图（Knip）应继续沿用 `--sarif` / `--knip` 叠加层接入，不重复造轮子。

---

## 2. 架构层腐化（Architecture Rot）：理论框架与工具版图

### 2.1 架构侵蚀、架构漂移与 LLM 五大漂移家族

经典文献区分**架构侵蚀（Erosion，明确违反预设架构规则）**与**架构漂移（Drift，对架构意图不敏感导致边界逐渐模糊）**（[Perry & Wolf 1992](https://users.ece.utexas.edu/~perry/work/papers/swa-sen.pdf)）。在 AI 编程工作流下，[Yergattikar (GroundLM 2026)](https://aclanthology.org/2026.groundlm-1.76.pdf) 将 LLM 诱发的架构漂移归纳为五类可确定性检测的家族与一类开放前沿：

| 漂移家族 | 受腐化的架构原语 | LLM 诱因 | 确定性可检性 | `codefog` 现状 |
| :--- | :--- | :--- | :---: | :--- |
| **1. Boundary & Layering Violation（边界与分层违背）** | 模块依赖图 / 调用图 | 取局部最短路径直接跨层导入 | 高（需依赖图 + 边界规则） | 未覆盖 |
| **2. Capability Regression（能力静默退化）** | 既有不变量 / 行为契约 | 局部编辑顺手删掉校验、重试或边界分支 | 高 | **核心强项**（`fog-returned` + `verify --mutants` 分支防删 + Oracle Contest） |
| **3. Contract & Interface Drift（契约与接口漂移）** | 跨文件接口 / 文档 / API 契约 | 只改契约一侧，另一侧不在上下文窗口 | 中–高 | **部分覆盖**（Doc Claims 覆盖文档↔代码；未覆盖跨模块导出签名破坏） |
| **4. Undocumented Expansion（未登记膨胀）** | 模块清单 / 依赖清单 | 不知道已有模块，重复造轮子或乱加依赖 | 中 | 仅通过 `--libyear` / `--knip` 间接覆盖 |
| **5. Invariant & Policy Erosion（安全与策略侵蚀）** | 显式安全/合规策略 | 生成时上下文无策略约束 | 中 | 可通过 `--sarif` 外部叠加 |
| **6. Convention Divergence（惯例分化，开放前沿）** | 团队惯用法 / 命名风格 | 通用先验压倒本地惯例 | 低（主观） | 仅能覆盖 `GLOSSARY.md` 术语与结构化规则 |

> **关键实证警告（[arXiv:2606.13298](https://arxiv.org/pdf/2606.13298v1.pdf)）**：对 151 个 Java 仓库、1,811 份月度 Arcan 快照的因果研究显示，AI 时代代码行数扩张（+12.8%）会导致按 LOC 归一化的架构坏味道密度（ASD）表面下降 6.7%，而绝对坏味道数并未减少（+1.1%）。因此，架构健康指标必须报告**绝对数量与增量变化**，避免被分母膨胀欺骗。

### 2.2 无需手写规则即可计算的“演化架构腐化”模型

很多团队不愿维护复杂的架构配置文件。学术界（Drexel / CMU SEI 的 Titan & DV8 体系）与工业界（CodeScene）证明，**仅结合静态依赖图 + Git 提交历史，就能零配置发现高成本架构债**：

1. **四大架构反模式（[Mo et al. 2015 / Cai & Kazman 2016](https://dl.acm.org/doi/pdf/10.1145/2896935.2896940)；[CMU SEI](https://www.sei.cmu.edu/blog/a-case-study-in-locating-the-architectural-roots-of-technical-debt/)；[DV8](https://par.nsf.gov/servlets/purl/10194572)）**：
   - **Cyclic Dependency（循环依赖）**：文件级或模块级强连通分量（SCC），导致模块无法独立构建、测试或拆出。
   - **Unstable Interface（不稳定接口）**：高扇入（被大量其他文件依赖）的核心文件同时具备高变更频率与高缺陷/未验证风险，每次修改都波及下游。
   - **Modularity Violation / Implicit Cross-Module Dependency（模块化违背 / 隐式跨模块耦合）**：两个分属不同模块、**不存在静态 import 关系**的文件在 Git 历史中高频共同修改（[Wong et al. ICSE 2011, Clio](https://doi.org/10.1145/1985793.1985850)）。注意需过滤健康的**“生产文件 ↔ 测试文件”共变**（[CodeScene Change Coupling](https://codescene.com/blog/change-coupling-visualize-the-cost-of-change)）。
   - **Improper Inheritance（不当继承）**：父类依赖子类，或调用方同时依赖父类与子类（偏重 OOP 语言）。
2. **系统级模块化度量**：
   - **Decoupling Level (DL)**（[Mo et al. ICSE 2016](https://dl.acm.org/doi/pdf/10.1145/2896935.2896940)）：度量系统拆分为小而独立可替换模块的程度；跨 129 个项目 60% 位于 46%–75%，非重构期的显著下跌往往预示架构退化。
   - **Propagation Cost (PC)**（[MacCormack et al. 2006 / DV8](https://par.nsf.gov/servlets/purl/10194572)）：基于依赖矩阵传递闭包的变更传播概率，直接对应“改一个文件可能影响全仓多大比例”。

### 2.3 主流架构反腐化工具对比矩阵

| 工具 | 支持语言 | 静态依赖与边界规则 | 演化共变（Git） | AI Agent 闭环 / 门禁 | 形态与局限 |
| :--- | :--- | :--- | :---: | :--- | :--- |
| **[SonarQube Architecture Management](https://www.sonarsource.com/blog/code-architecture-management-general-availability-in-sonarqube/)** (2026 GA) | Java, JS/TS, Python, C# | 自动逆向依赖图 + 图形化预期架构 + Quality Gate | 弱 | “Vibe, then Verify” PR 门禁 | 商业云/服务端部署，不支持 Go / Rust |
| **[CodeScene + CodeHealth MCP](https://codescene.com/product/code-health-mcp)** | 多语言（25+） | 25–30 因子 Code Health、X-Ray | **极强**（文件/模块/架构三级 Change Coupling） | **本地 MCP Server** + `AGENTS.md` 强制重构循环 | 商业专有评分，无测试断言数据流/变异反作弊验收 |
| **[Sonargraph](https://blog.hello2morrow.com/2017/03/evolving-sonargraph/)** | Java, C#, C/C++ | 严谨 Architecture DSL（strict/relaxed/independent 层）、ACD、环检测 | 无 | CI 插件 | 商业，需编译产物，无 TS/Go/Rust |
| **[Teamscale](https://docs.teamscale.com/reference/ui/architecture/)** | Java, JS/TS, C/C++/C#, Python 等（Rust 仅结构/测试，暂无架构一致性） | `.architecture` 层次组件 + allow/deny/tolerate + unmatched files | 增量发现项 | CI 门禁 | 商业平台，配置门槛高 |
| **[DV8](https://par.nsf.gov/servlets/purl/10194572)** | 多语言（依赖 Understand 等逆向器） | DRSpaces、DL、PC、4 类架构反模式 | **极强**（History DSM） | 无 Agent 闭环 | 商业/学术工具链，部署重 |
| **[GYROCOMPASS](https://aclanthology.org/2026.groundlm-1.76.pdf)** (2026) | Tree-sitter 15+ 语言（验证集中于 Py / JS / TS） | 6 原语声明式模型 + 漂移 diff + 规则引擎 | 漂移记忆日志 | **MCP 规划期上下文 + CI 不可绕过门禁** | 2026 早期研究/开源系统，依赖 Tree-sitter |
| **[dependency-cruiser](https://github.com/sverweij/dependency-cruiser)** / **[ArchUnit](https://blog.oneenv.io/articles/archunit-architecture-tests-and-dependency-cruiser-for-monolith-layers)** / **[Spring Modulith](https://docs.spring.io/spring-modulith/reference/verification.html)** / **[go-arch-lint](https://github.com/fe3dback/go-arch-lint)** / **[cargo-modules](https://github.com/regexident/cargo-modules/)** | 各管单一语言 | 各自的层级/切片/环规则（Go 有编译器 `internal/`；`cargo-modules --acyclic` 存在 `impl` 归属误报 [Issue #307](https://github.com/regexident/cargo-modules/issues/307)） | 无 | 单语言 CI / 单测 | 碎片化：多语言仓库需维护 4 套工具与语法 |

---

## 3. 结合 codefog 现有定位与架构底盘的方案评估（【建议】）

### 3.1 `codefog` 当前定位的不可动摇内核

对照 `GLOSSARY.md` 与 6 份 ADR，`codefog` 的立身之本有四条：
1. **雾优先五态证据模型（ADR-0001 / ADR-0004 / ADR-0005）**：五态只回答一件事——**“这段代码或这条声明是否有新鲜、有效且独立的验证证据”**。已验证区域退化为背景，唯一警示橙只给 `fog-returned`。
2. **零二进制、四语言开箱即跑（ADR-0003）**：纯 TypeScript 适配器覆盖 TS/JS、Go、Rust、Java，~200 KB 分发体积，不强制用户预装 4 套编译器或 Tree-sitter `.wasm`。
3. **双层采集 + 反作弊定点验收（ADR-0002）**：全仓秒级静态/Git 扫描 + `codefog verify` 定点反作弊验收闭环。
4. **面向人类与 AI Agent 的统一真相**：确定性 `CF-xxxx` ID、机器可读 JSON、可离线打开的四层 HTML 雾图与 PR 增量门禁。

同时，`codefog` 仓库内**已经有四块尚未充分复用的现成底盘**：
- `src/git-freshness.ts` 已在拉取 Git 提交历史与 90 天 churn → 增加“提交级文件共变矩阵”与“14 天短期返工”几乎不需要额外外部依赖。
- `src/ast-evidence.ts` 与 `src/polyglot.ts` 已在解析 TS/JS、Go、Java 的 `import` 与调用图，补齐 Rust `use` / `mod` 解析后，即可跨四语言统一构建**文件/模块静态依赖图**。
- `src/ts-ast-utils.ts` 与 `src/polyglot.ts` 已切分所有函数区间 → 可同步产出**认知复杂度、最大嵌套深度、函数规模与错误吞咽模式**。
- `src/verify.ts` + `skills/codefog/SKILL.md` 已有反作弊门禁与 Agent 修复闭环 → 可直接承接架构适应度函数的“确定性验收”。

### 3.2 四条演进方案对比评估

| 评估维度 | 方案 A：外部聚合器（Overlay-Only） | 方案 B：全功能代码/架构平台（Sonar+CodeScene 化） | **方案 C：演化结构 + 轻量架构适应度双轨（推荐）** | 方案 D：MCP 规划期守护优先（GYROCOMPASS 化） |
| :--- | :--- | :--- | :--- | :--- |
| **核心思路** | 不自建任何代码/架构分析，只扩展 `--sarif` / `--depcruise` / `--archunit` 导入 | 自建 25+ 因子 Code Health、全仓克隆检索、完整类型级架构 DSL、服务端/历史库 | 内置零配置**代码演化复杂度 + 跨语言静态/共变架构健康**，辅以可选的极简边界契约与 `verify` 门禁 | 优先做 MCP Server，向 Agent 注入架构上下文并做 pre-commit 拦截 |
| **与当前定位契合度** | 高（无侵入），但长期天花板低 | **低**：与 SonarQube/CodeScene 正面竞争，稀释“雾优先证据地图”心智 | **极高**：把“证据 × 演化 × 确定性门禁”自然延伸到结构与架构 | 中：MCP 是交互通道，不是分析内核 |
| **零配置多语言体验** | **差**：用户需在多语言仓库自行配置 4 套外部工具 | 中：需引入 Tree-sitter `.wasm` 或编译器，违背 ADR-0003 | **优**：继续零二进制，TS/JS/Go/Rust/Java 统一产出 | 中：若无扎实底层提取器，上下文精度不够 |
| **独特差异化价值** | 弱（沦为可视化壳） | 弱（商业竞品成熟度高得多） | **强**：市面上唯一把**“高扇入不稳定接口 / 隐式跨模块共变”与“测试证据是否为空/回雾”交叉联动**的工具 | 中（GroundLM 2026 已证明上下文对小模型可能倒退，真正决定成败的是确定性门禁） |
| **误报与维护风险** | 极低 | **高**：重型静态规则在无完整类型系统下误报率高，会破坏 CI 门禁信任 | **可控**：文件/模块级 import、Git 共变、认知复杂度与显式边界规则均为高确定性信号 | 中：MCP 协议与多 IDE 适配分散研发精力 |
| **对现有架构改造量** | 小 | 极大（需重写引擎） | **渐进可控**（先统一 `LanguageAdapter`，再分阶段叠加） | 中–大 |

---

## 4. 推荐方案（方案 C）的详细架构设计与分阶段路线（【建议】）

### 4.1 架构设计原则（确保不破坏现有定位）

1. **指标隔离原则（延续 ADR-0005）**：
   - **绝不改变代码 `Trust Score` 与五态判定规则**。五态永远只表达“行为验证证据”。
   - 结构腐化与架构腐化通过两条洁净渠道表达：
     - 局部结构/架构隐患作为 **`Risk Score` 的放大因子**（让“既复杂/高扇入、又缺乏测试证据”的代码自动浮到 Top Findings 与 Level 3 Hotspots 顶部）；
     - 架构级整体健康单独暴露为独立维度（如 `architecture` 报告段、可选的 `Architecture Health` / `Decoupling` 摘要与专项标签 `Finding`），与 `Doc Trust Score` 保持同构隔离。
2. **反“分母稀释”原则（吸收 arXiv:2606.13298）**：
   - `--diff` 与 PR 评论重点展示**净增指标**：新增循环依赖数、新增越界依赖边数、新增高认知复杂度函数数、新增块级复制与错误吞咽数；CI 门禁默认支持“只拦截新增退化（ratchet / baseline）”，不让存量历史债阻塞团队采用。
3. **低误报优先原则（吸收 GroundLM 2026）**：
   - 门禁只对**100% 确定性事实**亮红灯（模块环依赖、显式声明的禁止跨层导入、错误吞咽/分支删减）；启发式指标（如跨模块 Git 共变、认知复杂度偏高）先作为高风险提示与 `Finding`，由团队决定是否升级为门禁。

### 4.2 分阶段实施路线

#### Phase 0（前置地基）：补全统一 `LanguageAdapter` 接缝
- **为什么必须先做**：目前 `src/polyglot.ts` 超过 2,500 行，且 TS/JS 与 Go/Rust/Java 仍走双轨分支（`if (isPolyglotSourceFile)` 散落在 5 个文件）。如果在此基础上叠加依赖图与认知复杂度，代码腐化会先发生在 `codefog` 自己身上。
- **具体动作**：
  - 将 `src/polyglot.ts` 按语言拆为 `src/adapters/{ts,go,rust,java}.ts` 并由统一 `LanguageAdapter` 注册表调度；
  - 在 `LanguageAdapter` 接口上新增两个轻量确定性方法：
    - `extractFileDependencies(sourceText, filePath, context): FileDependencyEdge[]`（文件/模块级 import 边）；
    - `computeCognitiveComplexity(sourceText, span): { cognitiveComplexity: number; maxNestingDepth: number; errorMaskingLines: number[] }`。

#### Phase 1（代码层反腐化）：认知复杂度 + 演化返工 + PR 增量腐化哨兵
- **能力内容**：
  1. **函数级可读性/结构画像**：每个 `FileSymbolRegion` 增补可选字段 `cognitiveComplexity`、`maxNestingDepth`、`shortTermChurn14d`；在 `Risk Score` 或 `Finding.evidence` 中高亮**“高频修改 × 高认知复杂度 × 弱证据/雾”**的致命交集（此类函数一旦重构，极易引入静默回归）。
  2. **PR 增量腐化检测（`--diff`）**：
     - 识别本次 PR 引入的**认知复杂度跃升**（例如单函数认知复杂度新增 ≥ +10 或突破阈值）；
     - 识别新增的**错误吞咽（Error-Masking）**片段（空 `catch`、丢弃 `err`、生产代码裸 `.unwrap()`）；
     - 识别本次 diff 内**新增块级重复（≥ 6 行归一化重复块）**，直接对抗 AI “复制粘贴代替抽象复用”。
  3. **死代码联动**：当导入 `--knip` 报告时，把“落在 `fog` / `weak-evidence` 中的死文件/死导出”标为 `dead-code-fog` 标签，提示 Agent **优先删除死代码，禁止给死代码补测试刷分**。

#### Phase 2（架构层反腐化 · 零配置版）：静态依赖图 × Git 共变交叉引擎
- **能力内容**（无需任何配置文件，开箱即跑）：
  1. **跨四语言模块依赖图与环检测**：基于 `LanguageAdapter.extractFileDependencies` 与现有 `deriveModulePath`（`src/*`、`internal/*`、`pkg/*`、`crates/*`、`src/main/java/*`），自动计算：
     - **循环依赖（`arch-cycle`）**：模块级/包级强连通分量（Tarjan SCC）；
     - **传播成本（Propagation Cost）**与模块**扇入/扇出（Fan-in / Fan-out）**。
  2. **不稳定核心接口（`unstable-interface`）—— `codefog` 独有交叉视角**：
     - 联合三路信号：**高扇入（被大量文件依赖）× 高变更率（90d churn）× 低证据质量（`fog` / `weak-evidence` / `fog-returned`）**。
     - 这是传统架构工具（没有断言/变异证据）和传统测试工具（没有依赖扇入图）都单独看不到的最高危腐化源。
  3. **隐式跨模块共变（`modularity-violation`）**：
     - 复用 `git-freshness.ts` 的 Git 历史扫描单次提交共同修改的文件对，排除“生产文件 ↔ 测试文件”健康共变与全局配置/锁文件后，找出**无静态依赖、分属不同模块却高频一起改动的隐式耦合组**（例如 A 模块的 parser 改了，B 模块的手写常量表总要跟着改）。
  4. **雾图与 PR 报告呈现**：
     - Level 2（Module 视图）增加模块依赖环与不稳定接口提示；`--diff` 报告中标出本次 PR 是否新增了模块环或放大了高扇入接口的回雾半径（Blast Radius）。

#### Phase 3（架构层反腐化 · 契约与 Agent 闭环版）：可执行架构适应度函数 + 门禁
- **能力内容**：
  1. **极简声明式边界契约（可选，如 `.codefog/architecture.json`）**：
     - 定义模块分组、依赖规则（`allow` / `forbid`、`noCycles: true`、`publicSurface` 仅允许通过入口文件导入，附 `because` 原因说明，借鉴 ArchUnit 与 dependency-cruiser 的最佳实践）；
     - 支持 `baseline` 记录存量违例，CI 门禁（如 `--fail-on arch-violation`）默认严拦新增越界。
  2. **扩展 `codefog verify` 与 `SKILL.md` 闭环**：
     - 在 `codefog verify` 中增加架构一致性校验（Agent 修改代码或做重构时，不仅不能删分支/作弊通过变异测试，也不能通过引入跨层捷径或循环依赖来“绕过”问题）；
     - 将“删除死代码 / 拆解高认知复杂度热点 / 消除新增架构越界”写入 `SKILL.md` 的标准化重构步骤（借鉴 CodeScene 的 3–5 步小步重构 + 逐步复验闭环）。
  3. **可选的轻量本地 MCP 暴露层**：
     - 当 Phase 1–3 的确定性引擎稳定后，再提供一个薄 MCP 包装层（暴露 `get_fog_map_summary`、`get_blast_radius`、`check_architecture_and_fog`、`verify_target`），让 Agent 在写代码前能查模块边界与影响半径，写完后仍由确定性 CI 门禁兜底。

---

## 5. 未能核实的事项与技术边界

- **纯词法扫描器在多语言依赖解析上的精度上限**：在保持 ADR-0003 零二进制约束的前提下，文件/包级 `import` / `use` 解析能以极高准确率覆盖静态模块依赖与分层规则，但无法像完整编译器（`javac` / `rust-analyzer` / `go/types`）那样解析动态反射、宏展开生成的导入或泛型接口多态派发。因此架构边界检查应明确界定为**静态导入/模块级确定性检查**，而非全程序运行时调用图证明（正如 GroundLM 2026 建议：明确声明规则覆盖范围，不做“对抗完备性”的过度承诺）。
- **Git 共变的噪音边界**：在单仓库大规模格式化提交、版本批量升级提交或浅克隆（`fetch-depth: 1`）仓库中，共变统计容易失真；实现时需过滤单次触及文件数过多的批量提交（如 > 30 个文件）并在浅克隆时按 `Report Warning` 机制提示历史不足，而不是给出误导性 0 违规结论。
- **尚未核实的商用细节**：SonarQube 2026 Architecture Management 的具体定价分层与底层规则语言细节、CodeScene Code Health 全部 25–30 个语言因子的完整权重公式均未公开，本文仅引用其公开文档与论文中的事实。

---

## 参考文献

1. Perry, D. E., & Wolf, A. L. (1992). *Foundations for the Study of Software Architecture*. ACM SIGSOFT SEN. <https://users.ece.utexas.edu/~perry/work/papers/swa-sen.pdf>
2. Wong, S., Cai, Y., Kim, M., & Dalton, M. (2011). *Detecting Software Modularity Violations*. ICSE 2011. <https://doi.org/10.1145/1985793.1985850> · [PDF](https://web.cs.ucla.edu/%7Emiryung/Publications/icse11-modularityviolation.pdf)
3. Cai, Y., & Kazman, R. (2016). *Software Architecture Health Monitor*. Bridge '16 / ACM. <https://dl.acm.org/doi/pdf/10.1145/2896935.2896940>
4. Cai, Y., & Kazman, R. (2019). *DV8: Automated Architecture Analysis Tool Suites*. NSF PAR. <https://par.nsf.gov/servlets/purl/10194572>
5. CMU Software Engineering Institute. *A Case Study in Locating the Architectural Roots of Technical Debt*. <https://www.sei.cmu.edu/blog/a-case-study-in-locating-the-architectural-roots-of-technical-debt/>
6. Tornhill, A., & Borg, M. (2022). *Code Red: The Business Impact of Code Quality — A Quantitative Study of 39 Proprietary Production Codebases*. <https://arxiv.org/pdf/2203.04374>
7. Campbell, G. A. (2023). *Cognitive Complexity: A new way of measuring understandability* (v1.7). SonarSource. <https://www.sonarsource.com/docs/CognitiveComplexity.pdf>
8. Ford, N., Parsons, R., Kua, P., & Sadalage, P. (2022). *Building Evolutionary Architectures* (2nd ed., Ch. 2: Fitness Functions). O'Reilly. <https://www.oreilly.com/library/view/building-evolutionary-architectures/9781492097532/ch02.html> · Thoughtworks: [Fitness function-driven development](https://www.thoughtworks.com/insights/articles/fitness-function-driven-development)
9. He, H., et al. (2025). *Does AI-Assisted Coding Deliver? A Difference-in-Differences Study of Cursor's Impact on Software Projects*. <https://arxiv.org/html/2511.04427v2>
10. Agarwal, S., He, H., & Vasilescu, B. (2026). *AI IDEs or Autonomous Agents? Measuring the Impact of Coding Agents on Software Development*. MSR 2026 / <https://arxiv.org/html/2601.13597>
11. *Mining Architectural Quality Under Agentic AI Adoption: A Causal Study of Java Repositories* (2026). <https://arxiv.org/pdf/2606.13298v1.pdf>
12. Yergattikar, S. (2026). *Agents Out of Bounds: A Taxonomy of Architectural Drift and a Deployment-Ready Guardrail Framework for LLM Coding Agents*. ACL GroundLM 2026. <https://aclanthology.org/2026.groundlm-1.76.pdf>
13. GitClear Research (2025 / 2026). [AI Copilot Code Quality 2025](https://www.gitclear.com/ai_assistant_code_quality_2025_research) · [The Maintainability Gap: 2026 AI Code Quality Research](https://www.gitclear.com/the_ai_code_quality_maintainability_gap) · 方法评述：[Big Agile](https://big-agile.com/blog/ai-technical-debt-refactoring)
14. CodeScene: [CodeHealth MCP Server](https://codescene.com/product/code-health-mcp) · [AGENTS.md](https://github.com/codescene-oss/codescene-mcp-server/blob/main/AGENTS.md) · [Change Coupling](https://codescene.com/blog/change-coupling-visualize-the-cost-of-change) · [Terminology](https://codescene.io/docs/terminology/codescene-terminology.html)
15. SonarSource (2026): [Code architecture management GA in SonarQube](https://www.sonarsource.com/blog/code-architecture-management-general-availability-in-sonarqube/) · [Architectural Drift](https://www.sonarsource.com/blog/the-architecture-gap-why-your-code-becomes-hard-to-change/)
16. Sonargraph: [Architecture DSL](https://blog.hello2morrow.com/2017/03/evolving-sonargraph/) · [sonar-sonargraph-integration](https://github.com/sonargraph/sonar-sonargraph-integration)
17. Teamscale: [Architecture Perspective Docs](https://docs.teamscale.com/reference/ui/architecture/) · [Architecture Conformance Analysis](https://teamscale.com/features/architecture-conformance-analysis)
18. 语言生态边界工具：[dependency-cruiser](https://github.com/sverweij/dependency-cruiser) · [ArchUnit](https://blog.oneenv.io/articles/archunit-architecture-tests-and-dependency-cruiser-for-monolith-layers) · [Spring Modulith Verification](https://docs.spring.io/spring-modulith/reference/verification.html) · [go-arch-lint](https://github.com/fe3dback/go-arch-lint) · [cargo-modules](https://github.com/regexident/cargo-modules/)（含 `impl` 环误报 [Issue #307](https://github.com/regexident/cargo-modules/issues/307)）
