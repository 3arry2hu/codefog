# 采用「全仓静态 + 按需定点变异」的双层证据采集架构

变异测试（Mutation Testing）和动态后向切片（Checked Coverage）是识别 `Weak Evidence` 与 `Pseudo-tested Method` 最可靠的手段，但在中大型 TS/JS 仓库中全量运行往往耗时数十分钟，无法满足日常开发与 PR 快速反馈的需求。我们决定采用**双层证据采集架构**：基础层通过读取标准 `lcov.info`、Git 历史与 TS AST 静态数据流分析，在秒级内完成全仓扫描并计算近似 `Checked Coverage`；增强层支持导入现有 Stryker 报告，并通过 `npx codefog verify <target> --mutants` 仅针对单个热点文件或 `Finding` 关联的测试文件执行秒级定点变异与伪测试检验。

## Consequences

- 任何具备 `lcov.info` 的 TS/JS 仓库均可零配置秒级生成具备五态区分度的 `Fog Map`。
- AI Coding Agent 在修复某个 `Finding` 后，无需重跑全量测试套件，只需运行 `npx codefog verify <file> --mutants` 即可在数秒内完成“杀死变异体 + 防刷分 AST 校验”的验收闭环。
