# 调研：代码与文档腐化（Code & Documentation Rot）及市面产品

> 调研日期：2026-11-05。所有事实性陈述都附了一手来源链接（论文原文、官方文档或官方仓库）。标注 **【建议】** 的段落是本文作者对 codefog 的判断，不是来源中的事实。

## TL;DR

- **腐化没有统一的学术定义，它是几类现象的总称**：Lehman 的“持续变更 / 复杂度递增”定律、Cunningham 的技术债、Perry & Wolf 的架构侵蚀与架构漂移，再加上依赖过期、死代码和测试失效。它们的共同点是：**系统在变，而某个原本成立的“约定”没有跟着变**。
- **测试腐化有量化证据**：在只有单元测试的项目里，约 9%–19% 被测试执行过的方法属于“伪测试”，也就是把方法逻辑删掉测试照样通过（[Niedermayr et al. 2016](https://arxiv.org/abs/1611.07163)）。codefog 现有的 `verify --mutants` 函数体清空检测正是这一思路。
- **文档腐化同样有量化证据**：在 ICSE 2019 的文档问题分类研究中，“过时（Up-to-dateness）”占内容类问题的 190/485，约 39%；正确性问题中有 50% 出在代码示例上（[Aghajani et al. 2019](https://csnagy.github.io/research/pdfs/2019/Aghajani2019-preprint.pdf)）。只有 13%–20% 的代码变更会同时更新相关注释（[Wen et al. 2019](https://www.inf.usi.ch/lanza/PUBS/P/Wen2019a.pdf)）。
- **AI 指令文件（AGENTS.md / CLAUDE.md / Cursor rules）是新的腐化源头**：一项覆盖 1,000 个仓库、3,387 个文件的研究发现，42.2% 的仓库同时维护多种格式，对应章节中 16.1% 互相矛盾，40.4% 的文件只被修改过一次（[arXiv 2611.02383](https://arxiv.org/abs/2611.02383)）。
- **市面工具高度碎片化**：代码健康（SonarQube、CodeScene、Qlty）、架构规则（ArchUnit、dependency-cruiser）、死代码（Knip）、依赖（Renovate、libyear、OpenSSF Scorecard）、测试有效性（Stryker、PITest）、文档（Swimm、Mintlify、DeepWiki、Vale、lychee）、API 契约（oasdiff）各管一摊。
- **“代码改了，而依赖它的文档、注释、指令文件没有跟着改”这一维度，目前只有零散方案**：Swimm 的 Auto-sync（商业、要求使用其文档格式）、几款早期开源 GitHub Action（DocEye、RealityLint、doc-freshness-checker、Knowledge Diff、Doc Drift）。没有一款把它和测试证据、Git 时间线、AI Agent 修复闭环放在同一个模型里。
- **【建议】codefog 最有差异化的方向**：把现有的 `fog-returned`（代码改了但测试没跟上）机制推广到文档，即“文档声明（claim）指向的代码改了，而声明本身没跟上”（文档回雾），并复用五态模型、`verify` 反作弊网关和 AI Skill 闭环。

---

## 1. 什么是代码腐化

### 1.1 经典定义

| 概念 | 原始出处 | 核心表述 |
| :--- | :--- | :--- |
| 持续变更 / 复杂度递增定律 | [Lehman 1980, *Programs, Life Cycles, and Laws of Software Evolution*](https://www.ifi.uzh.ch/dam/jcr:00000000-2f41-7b40-ffff-ffffd5af5da7/lehman80.pdf) | 被使用的程序要么持续变更，要么越来越没用；程序在持续变更中，复杂度会随结构劣化而上升，“除非投入工作去维持或降低它”。 |
| 技术债 | [Cunningham 1992, *The WyCash Portfolio Management System*](http://c2.com/doc/oopsla92.html) | “交付第一版代码就像借债”；不偿还时，“花在不太对的代码上的每一分钟都是利息”。 |
| 架构侵蚀 vs 架构漂移 | [Perry & Wolf 1992, *Foundations for the Study of Software Architecture*](https://users.ece.utexas.edu/~perry/work/papers/swa-sen.pdf) | 侵蚀（erosion）是违反架构；漂移（drift）是对架构不敏感，导致结构失去清晰度，从而更容易被违反。 |

### 1.2 按维度拆分

| 腐化维度 | 表现 | 典型度量 |
| :--- | :--- | :--- |
| 结构腐化 / 设计劣化 | 复杂函数、重复代码、深层嵌套、上帝类 | SonarQube 技术债比率与可维护性评级（[文档](https://docs.sonarsource.com/sonarqube-cloud/managing-your-projects/metric-definitions)）；CodeScene Code Health 1–10 分，基于 25+ 个因子（[文档](https://codescene.io/docs/guides/technical/code-health.html)） |
| 架构侵蚀 | 分层越界、循环依赖 | ArchUnit / dependency-cruiser 规则违规数 |
| 死代码 | 未使用的文件、导出、依赖 | Knip 报告的未使用项（[knip.dev](https://knip.dev/)） |
| 依赖腐化 | 依赖版本落后、上游不再维护 | libyear：当前所用版本与最新稳定版之间的发布时间差（[CHAOSS](https://www.chaoss.community/kb/metric-libyears/)）；OpenSSF Scorecard 的 `Maintained`、`Dependency-Update-Tool` 检查（[checks.yaml](https://github.com/ossf/scorecard/blob/main/docs/checks/internal/checks.yaml)） |
| 测试腐化 | 测试执行了代码却检测不出错误（伪测试）、测试不稳定（flaky）、代码改了测试没改 | 变异得分；伪测试方法比例（[Niedermayr et al.](https://arxiv.org/abs/1611.07163)）；flaky 检测（[Trunk](https://docs.trunk.io/flaky-tests/get-started)） |
| 演化热点 | 改得最频繁、质量又最差的代码 | CodeScene Hotspots 与 Change Coupling（[文档](https://codescene.io/docs/terminology/codescene-terminology.html)） |

**测试腐化的关键证据**：Niedermayr 等人用“极端变异”（清空整个方法体或替换成常量返回）测量伪测试方法，发现只有单元测试的项目中约 9%–19% 被执行的方法是伪测试，并得出结论：覆盖率只对单元测试才算有效的有效性指标（[arXiv 1611.07163](https://arxiv.org/abs/1611.07163)）。PITest 的 Descartes 引擎实现了这类算子（[STAMP](https://stamp.ow2.org/view/kb/pitest-descartes)）。

---

## 2. 什么是文档腐化

文档腐化（又称 doc drift / documentation rot）指**文档原本正确，但系统变更后不再与之同步**。Aghajani 等人对此有明确界定：“过时”与“错误”“不完整”的区别在于，这些信息在变更发生之前是正确且完整的（[ICSE 2019 预印本](https://csnagy.github.io/research/pdfs/2019/Aghajani2019-preprint.pdf)）。

### 2.1 实证数据

| 研究 | 规模 | 关键发现 |
| :--- | :--- | :--- |
| [Aghajani et al., *Software Documentation Issues Unveiled*, ICSE 2019](https://dl.acm.org/doi/10.1109/ICSE.2019.00122) | 878 份文档相关制品，162 种问题类型 | 内容类问题共 485 例，其中过时问题 190 例（约 39%）；正确性问题里代码示例占 50%，安装指南占 20%。 |
| [Wen et al., *A Large-Scale Empirical Study on Code-Comment Inconsistencies*, ICPC 2019](https://www.inf.usi.ch/lanza/PUBS/P/Wen2019a.pdf) | 1,500 个 Java 项目，约 13 亿次 AST 级变更 | 仅 13%–20% 的代码变更会触发注释更新；给出了代码与注释不一致的分类。 |
| [Panthaplackel et al., *Deep Just-In-Time Inconsistency Detection Between Comments and Source Code*, AAAI 2021](https://arxiv.org/abs/2010.01625) | 1,518 个 Java 项目，40,688 个样本 | 在提交之前，把注释和代码变更关联起来，检测“注释因本次改动而失效”，并接入注释自动更新模型。 |
| [Chatlatanagulchai et al., *Agent READMEs*, arXiv 2511.12884](https://arxiv.org/html/2511.12884v2) | 1,925 个仓库中的 2,303 个 Agent 上下文文件 | 这些文件“像配置代码一样演化”，以频繁的小幅追加为主；62.3% 包含构建 / 运行命令。 |
| [*Toward an Evidence-Based Template for Agent Instruction Files*, arXiv 2611.02383](https://arxiv.org/abs/2611.02383) | 1,000 个仓库中的 3,387 个指令文件 | 42.2% 的仓库同时维护多种格式；对应章节 16.1% 互相矛盾；40.4% 的文件只被修改过一次。 |

### 2.2 文档腐化的形态

| 形态 | 例子 |
| :--- | :--- |
| 符号 / 路径失效 | README 提到的函数、文件、配置项已被改名或删除 |
| 命令失效 | 文档里的 `npm run xxx`、CLI 参数或 Docker 命令已不存在 |
| 代码示例过时 | 示例的 import、函数签名、返回值与当前实现不符 |
| 行为描述过时 | 注释或 ADR 描述的算法、阈值、默认值已被修改 |
| 链接失效 | 外部 URL 返回 404，或锚点指向已删除的标题 |
| API 契约漂移 | OpenAPI 规范与实现不一致，或出现破坏性变更 |
| 多源互相矛盾 | AGENTS.md、CLAUDE.md、`.cursor/rules` 对同一件事说法不同 |

---

## 3. 市面产品与功能

### 3.1 代码健康 / 技术债平台

| 产品 | 检测什么 | 机制 | 形态 / 许可 |
| :--- | :--- | :--- | :--- |
| [SonarQube](https://docs.sonarsource.com/sonarqube-cloud/managing-your-projects/metric-definitions) | 可维护性问题、技术债（修复所需分钟数）、技术债比率、A–E 评级、覆盖率、重复代码 | 规则引擎；“Clean as You Code”把新代码与存量代码分开计算并设门禁（[文档](https://docs.sonarsource.com/sonarqube-server/10.6/user-guide/clean-as-you-code)） | Server / Cloud；社区版开源，高级版商业 |
| [CodeScene](https://codescene.io/docs/terminology/codescene-terminology.html) | Code Health（1–10 分）、Hotspots、Change Coupling、X-Ray 函数级热点、测试代码坏味道（如重复断言块） | 行为代码分析：结合 Git 演化历史和组织维度，不只看当前快照；也会显示代码与测试的协同变更（[文档](https://codescene.digitgaming.com/docs/guides/technical/hotspots.html)） | SaaS / 本地部署；商业 |
| [Qlty（原 Code Climate Quality）](https://docs.qlty.sh/migration/overview) | 8 类代码坏味道（重复、复杂度、嵌套、参数过多等）、diff 覆盖率、SAST / SCA | 自研静态分析；`qlty smells --upstream origin/main` 做增量检查（[文档](https://docs.qlty.sh/cli/commands/smells)） | CLI 免费 + Cloud 商业；Code Climate Quality 已拆分为 Qlty Software（[公告](https://codeclimate.com/legacy/code-climate-quality-is-now-qlty-software)） |

### 3.2 架构侵蚀、死代码与依赖

| 产品 | 检测什么 | 机制 | 形态 / 许可 |
| :--- | :--- | :--- | :--- |
| [ArchUnit](https://www.archunit.org/userguide/html/000%5FIndex.html) | Java 包 / 类 / 分层依赖违规、循环依赖 | 分析字节码，把架构规则写成 JUnit 测试 | 开源库 |
| [dependency-cruiser](https://github.com/sverweij/dependency-cruiser) | JS / TS 的禁止依赖、循环依赖、孤儿模块、生产代码依赖 devDependencies | `forbidden` / `allowed` / `required` 规则（[规则参考](https://github.com/sverweij/dependency-cruiser/blob/master/doc/rules-reference.md)） | 开源 CLI |
| [Knip](https://knip.dev/) | JS / TS 中未使用的文件、导出和依赖 | 从框架入口点构建引用图，提供 190+ 插件 | 开源 CLI |
| [libyear](https://libyear.com/) / [OpenSSF Scorecard](https://github.com/ossf/scorecard/blob/main/docs/checks/internal/checks.yaml) | 依赖新鲜度；项目是否仍在维护、是否启用了 Dependabot / Renovate | 版本发布时间差；仓库活跃度与配置检查 | 开源 |

### 3.3 测试有效性（测试腐化）

| 产品 | 检测什么 | 机制 | 形态 / 许可 |
| :--- | :--- | :--- | :--- |
| [StrykerJS](https://stryker-mutator.io/docs/stryker-js/incremental/) | 存活变异体、变异得分 | 变异测试；`--incremental` 通过 git 式 diff 只重跑改动的代码和测试 | 开源 |
| [PITest + Descartes](https://stamp.ow2.org/view/kb/pitest-descartes) | Java 存活变异体、伪测试方法 | 极端变异：清空方法体或返回常量 | 开源 |
| [Trunk Flaky Tests](https://docs.trunk.io/flaky-tests/quarantining) | 不稳定测试 | 根据 CI 结果上传的失败率与重试通过率判定，并自动隔离 | SaaS；商业 |

### 3.4 文档腐化 / 文档即代码

| 产品 | 检测什么 | 机制 | 形态 / 许可 |
| :--- | :--- | :--- | :--- |
| [Swimm](https://docs.swimm.io/features/keep-docs-updated-with-auto-sync/) | 文档中引用的代码片段是否因代码变更而过时 | 专利技术 Auto-sync：在 CI 中自动同步常规改动；改动影响较大时让检查失败，并把文档标记为可能过时 | SaaS + IDE；商业；要求文档写在 Swimm 体系内 |
| [Mintlify Agent](https://www.mintlify.com/docs/agent) | 不做检测，负责改写：根据 PR、Slack 或提示词更新文档 | LLM Agent 阅读文档与关联仓库后发起 PR，并运行 Mintlify CLI 校验构建 | SaaS；Pro / Enterprise |
| [DeepWiki（Devin）](https://docs.devin.ai/work-with-devin/deepwiki) | 不做检测，从代码重新生成 wiki | 为仓库自动生成架构图和文档；带官方徽章的公开仓库会自动刷新（[仓库](https://github.com/CognitionAI/deepwiki)） | 公开仓库免费；私有仓库需 Devin 账号 |
| [Vale](https://github.com/vale-cli/vale) | 文风与术语规则，也能检查代码注释和 docstring | 解析标记语言，用 tree-sitter 提取注释，规则用 YAML 编写 | 开源 CLI |
| [lychee](https://github.com/lycheeverse/lychee) | 失效链接 | 异步检查 Markdown / HTML 等文件中的链接 | 开源 CLI / GitHub Action |
| [rustdoc 文档测试](https://doc.rust-lang.org/stable/rustdoc/write-documentation/documentation-tests.html) | 文档示例能否编译运行、断言是否成立 | `cargo test --doc` 把注释里的代码块当作测试执行 | Rust 工具链内置 |
| [oasdiff](https://www.oasdiff.com/docs/breaking-changes) | OpenAPI 破坏性变更（778 类变更规则） | 对比两个版本的规范，`breaking` 子命令可作为 CI 门禁；Optic CLI 已归档，官方迁移指南指向 oasdiff（[迁移文档](https://www.oasdiff.com/docs/migrate-from-optic)） | 开源 CLI + Pro |

**早期开源“文档漂移”工具**（仅在各自的官方仓库中核实过功能，成熟度未知）：

| 工具 | 是否用 LLM | 检测内容 |
| :--- | :--- | :--- |
| [DocEye](https://github.com/marketplace/actions/doceye-documentation-drift-detector) | 否 | 本地链接、锚点、`npm run` 脚本、`node` 命令、路径、运行时版本、workflow、Dockerfile、许可证 |
| [RealityLint](https://github.com/voonterr/realitylint) | 否 | 文档声明与仓库事实（脚本、路径、`.env.example`、Docker Compose、Go / Cargo 特性），支持基线模式和 SARIF 输出 |
| [doc-freshness-checker](https://github.com/cosmocoder/doc-freshness-checker/) | 否 | 文档中的符号、文件、版本和代码示例（import、函数签名、配置键），覆盖 JS / TS / Python / Go / Rust / Java，附新鲜度评分 |
| [Knowledge Diff](https://github.com/oarisur/knowledge-diff) | 是 | 根据 PR diff 匹配文档和 AGENTS.md / CLAUDE.md 中的相关章节，由 LLM 判断矛盾，可发起修复 PR |
| [Doc Drift](https://github.com/jbrockSTL/doc-drift) | 是 | 由 LLM 判断 PR 变更是否与文档冲突，可让构建失败 |

### 3.5 AI 审查与自动化重构

| 产品 | 与腐化相关的能力 | 来源 |
| :--- | :--- | :--- |
| CodeRabbit | 自动识别 AGENTS.md、CLAUDE.md、`.cursor/rules` 等文件并作为审查准则；为 PR 中的函数生成 docstring；记忆团队审查偏好 | [Code Guidelines](https://docs.coderabbit.ai/knowledge-base/code-guidelines)、[Docstrings](https://docs.coderabbit.ai/finishing-touches/docstrings) |
| OpenRewrite / Moderne | 在无损语义树（LST）上执行确定性的“配方”，完成框架迁移、依赖升级和安全修复；Moderne 可跨数千个仓库批量发起 PR | [OpenRewrite 文档](https://docs.openrewrite.org/)、[Moderne](https://moderne.ai/openrewrite) |

---

## 4. codefog 差距分析与机会

### 4.1 能力对比矩阵

图例：● 核心能力；◐ 部分支持；○ 不支持。codefog 一列依据当前仓库代码（v1.4.0）填写。

| 腐化维度 | codefog | SonarQube | CodeScene | Qlty | Stryker / PITest | Swimm | DocEye / RealityLint | Knowledge Diff 类 LLM 工具 |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| 测试证据腐化（伪测试、只做存活检查、存活变异体） | ● | ◐ 覆盖率 | ◐ 测试坏味道 | ◐ 覆盖率 | ● | ○ | ○ | ○ |
| 变更新鲜度（代码改了、测试没跟上） | ● `fog-returned` | ◐ 新代码门禁 | ◐ 代码与测试协同变更 | ◐ diff 覆盖率 | ◐ 增量模式 | ○ | ○ | ○ |
| 结构 / 设计腐化 | ◐ 圈复杂度只用于风险分 | ● | ● | ● | ○ | ○ | ○ | ○ |
| 架构侵蚀 | ○ | ◐ | ◐ | ○ | ○ | ○ | ○ | ○ |
| 死代码 | ○ | ◐ | ○ | ○ | ○ | ○ | ○ | ○ |
| 依赖腐化 | ○ | ◐ SCA | ○ | ◐ SCA | ○ | ○ | ◐ 版本声明 | ○ |
| 文档与代码漂移（符号、路径、命令） | ○ | ○ | ○ | ○ | ○ | ● 仅限 Swimm 文档 | ● | ◐ 依赖 LLM 判断 |
| 注释与代码不一致 | ◐ 新鲜度计算会剔除注释 | ○ | ○ | ○ | ○ | ○ | ○ | ◐ |
| 失效链接 / 示例 | ○ | ○ | ○ | ○ | ○ | ◐ | ● | ◐ |
| Agent 指令文件过时 / 矛盾 | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ◐ |
| AI Agent 闭环修复且有反作弊验收 | ● Skill + `verify` | ○ | ◐ | ○ | ○ | ○ | ○ | ◐ 修复 PR，无验收 |

**【建议】结论**：codefog 目前的护城河在“测试证据”与“变更新鲜度”两个维度，并且是唯一把**反作弊验收**接进 AI Agent 闭环的工具。如果要定位成“对抗代码与文档腐化”，结构腐化和依赖腐化应直接集成成熟工具，最大的空白、也最契合 codefog 现有引擎的是**文档与代码漂移**。

### 4.2 优先级建议（均为【建议】）

**P0：文档声明模型 + 文档回雾（Doc Fog Returned）**
把 README、`docs/**/*.md`、ADR、AGENTS.md、注释中可以被机器核对的句子抽取为“声明（claim）”，例如符号名、文件路径、CLI 参数、`npm run` 脚本、默认值字面量。每条声明绑定它引用的代码区域，再复用 `git-freshness.ts` 的时间线做判断：引用的代码在运行时逻辑层面发生了修改，而声明所在的段落没有更新，就判定为 `doc-fog-returned`。这与现有 `fog-returned` 同构，五态模型、Trust Score 和 `--fail-on returned` 门禁可以直接沿用。现有的去注释指纹能力正好可以过滤“只改了注释”造成的误报。

**P1：确定性的文档事实校验（零 LLM）**
对齐 DocEye / RealityLint 的规则集（路径、脚本、链接、锚点、运行时版本），但要覆盖 codefog 已支持的四种语言的符号解析（复用 `LanguageAdapter`）。这一层是 P0 的前置条件：P0 先判断“引用还存在吗”，再判断“引用的东西变了吗”。

**P2：把可执行文档当作证据**
借鉴 rustdoc doctest：README 中带断言的代码块执行通过，就把该声明升级为 `verified`；只能运行、没有断言，视为 `weak-evidence`；从未执行过，视为 `fog`。这样文档和代码共用同一套证据语义。

**P3：Agent 指令文件专项检查**
AGENTS.md / CLAUDE.md / `.cursor/rules` 中的命令必须真实存在；多个文件之间对同一主题的说法要做一致性比对，针对上文研究中 16.1% 互相矛盾的现象；文件引用的代码长期变动而文件本身未更新时，标记为过时。codefog 已经会安装多平台 Skill，与这一需求天然相邻。

**P4：扩展 AI Skill 闭环到文档**
Skill 新增“文档修复”阶段：Agent 只能修改文档，而且修改后的声明必须通过 P1 的事实校验和 P2 的执行校验，才算消除 `doc-fog-returned`。这样可以防止 Agent 为了消除告警把文档写得含糊其辞，对应现有 oracle 中“不得把断言字面量改成当前返回值”的约束。

**P5：集成而非重造**
结构腐化接入 Qlty / SonarQube 的 SARIF 输出，死代码接入 Knip，依赖接入 libyear / OpenSSF Scorecard，统一折算进 Risk Score，codefog 只负责汇总和雾图呈现。

---

## 5. 未能核实的事项

- **Swimm Auto-sync 的具体算法**：官方文档只说明是专利技术，以及 CI 失败和标记过时的行为，没有公开判定逻辑。
- **早期开源文档漂移工具**（DocEye、RealityLint、doc-freshness-checker、Knowledge Diff、Doc Drift）：只在各自仓库的 README 中确认了功能，未评估用户规模、维护活跃度和准确率。
- **未纳入的产品**：Codacy、DeepSource、NDepend、Teamscale、Sourcegraph、Qodo、GitHub Copilot code review、Renovate / Dependabot 的细节、Sonargraph / Lattix 等，本轮没有逐一查阅官方文档，因此没有写进表格，不代表它们不具备相关能力。
- **arXiv 2611.02383 与 2606.25257**：均为预印本，尚未确认是否已经过同行评审；后者是研究计划（registered report），还没有结果数据。

---

## 参考文献

1. Lehman, M. M. (1980). *Programs, Life Cycles, and Laws of Software Evolution*. Proc. IEEE. <https://doi.org/10.1109/proc.1980.11805> · [PDF](https://www.ifi.uzh.ch/dam/jcr:00000000-2f41-7b40-ffff-ffffd5af5da7/lehman80.pdf)
2. Cunningham, W. (1992). *The WyCash Portfolio Management System*. OOPSLA '92. <http://c2.com/doc/oopsla92.html>
3. Perry, D. E., & Wolf, A. L. (1992). *Foundations for the Study of Software Architecture*. ACM SIGSOFT SEN. <https://doi.org/10.1145/141874.141884>
4. Niedermayr, R., Juergens, E., & Wagner, S. (2016). *Will My Tests Tell Me If I Break This Code?* CSED '16. <https://arxiv.org/abs/1611.07163>
5. Aghajani, E., et al. (2019). *Software Documentation Issues Unveiled*. ICSE 2019. <https://dl.acm.org/doi/10.1109/ICSE.2019.00122> · [预印本](https://csnagy.github.io/research/pdfs/2019/Aghajani2019-preprint.pdf)
6. Wen, F., Nagy, C., Bavota, G., & Lanza, M. (2019). *A Large-Scale Empirical Study on Code-Comment Inconsistencies*. ICPC 2019. <https://doi.org/10.1109/icpc.2019.00019>
7. Panthaplackel, S., Li, J. J., Gligoric, M., & Mooney, R. J. (2021). *Deep Just-In-Time Inconsistency Detection Between Comments and Source Code*. AAAI 2021. <https://arxiv.org/abs/2010.01625>
8. Chatlatanagulchai, W., et al. *Agent READMEs: An Empirical Study of Context Files for Agentic Coding*. <https://arxiv.org/abs/2511.12884>
9. *Toward an Evidence-Based Template for Agent Instruction Files*. <https://arxiv.org/abs/2611.02383>
10. *How Do Developers Maintain and Evolve Their Agents' Instructions?* <https://export.arxiv.org/pdf/2606.25257>
11. AGENTS.md 官方站点：<https://agents.md/>
12. SonarQube 指标定义：<https://docs.sonarsource.com/sonarqube-cloud/managing-your-projects/metric-definitions>
13. CodeScene：[Code Health](https://codescene.io/docs/guides/technical/code-health.html) · [术语](https://codescene.io/docs/terminology/codescene-terminology.html) · [Change Coupling](https://codescene.io/docs/guides/technical/change-coupling.html)
14. Qlty：[迁移说明](https://docs.qlty.sh/migration/overview) · [smells](https://docs.qlty.sh/cli/commands/smells) · [Code Smells](https://docs.qlty.sh/code-smells)
15. ArchUnit 用户指南：<https://www.archunit.org/userguide/html/000%5FIndex.html>
16. dependency-cruiser：<https://github.com/sverweij/dependency-cruiser>
17. Knip：<https://knip.dev/>
18. libyear：<https://libyear.com/> · CHAOSS Libyears：<https://www.chaoss.community/kb/metric-libyears/>
19. OpenSSF Scorecard checks：<https://github.com/ossf/scorecard/blob/main/docs/checks/internal/checks.yaml>
20. StrykerJS Incremental：<https://stryker-mutator.io/docs/stryker-js/incremental/>
21. PITest Descartes：<https://stamp.ow2.org/view/kb/pitest-descartes>
22. Trunk Flaky Tests：<https://docs.trunk.io/flaky-tests/quarantining>
23. Swimm Auto-sync：<https://docs.swimm.io/features/keep-docs-updated-with-auto-sync/>
24. Mintlify Agent：<https://www.mintlify.com/docs/agent>
25. DeepWiki：<https://docs.devin.ai/work-with-devin/deepwiki> · <https://github.com/CognitionAI/deepwiki>
26. Vale：<https://github.com/vale-cli/vale>
27. lychee：<https://github.com/lycheeverse/lychee>
28. rustdoc 文档测试：<https://doc.rust-lang.org/stable/rustdoc/write-documentation/documentation-tests.html>
29. oasdiff：[破坏性变更规则](https://www.oasdiff.com/docs/breaking-changes) · [从 Optic 迁移](https://www.oasdiff.com/docs/migrate-from-optic)
30. DocEye：<https://github.com/marketplace/actions/doceye-documentation-drift-detector>
31. RealityLint：<https://github.com/voonterr/realitylint>
32. doc-freshness-checker：<https://github.com/cosmocoder/doc-freshness-checker/>
33. Knowledge Diff：<https://github.com/oarisur/knowledge-diff>
34. Doc Drift：<https://github.com/jbrockSTL/doc-drift>
35. CodeRabbit：[Code Guidelines](https://docs.coderabbit.ai/knowledge-base/code-guidelines) · [Docstrings](https://docs.coderabbit.ai/finishing-touches/docstrings)
36. OpenRewrite / Moderne：<https://docs.openrewrite.org/> · <https://moderne.ai/openrewrite>
