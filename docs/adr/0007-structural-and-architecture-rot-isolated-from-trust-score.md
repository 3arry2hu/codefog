# 结构与架构腐化信号独立于五态证据与 Trust Score，不引入第三个 0–100 总分

为了在不破坏 `codefog`“雾优先证据地图”核心定位的前提下对抗代码与架构腐化，我们决定将结构与架构腐化信号与五态证据模型及 `Trust Score` 严格隔离：代码复杂度、错误吞咽、块级复制、循环依赖、边界违例或隐式耦合都不会将 `verified` 代码降级或扣减 `Trust Score`，且全画面唯一的警示橙继续专留给 `Fog Returned`（延续 ADR-0001 与 ADR-0005）。局部高阈值结构隐患（如认知复杂度超过阈值或含错误吞咽）仅作为 `Risk Score` 放大乘数以提升排序优先级；架构级结果独立写入报告的 `architecture` 段，并通过 `subjectType: "architecture"` 与专项标签的 `Finding` 呈现。同时，我们不引入第三个 0–100 架构总分，而以绝对违例数、传播成本及 `--diff` 净增变化作为核心观测口径。

## Considered Options

- **将架构违例直接记为 `fog-returned` 并扣减 `Trust Score`**：混淆“测试证据过期”与“模块依赖越界”两种语义，且与 `Fog Returned` 争用唯一警示橙，违背 ADR-0001。
- **新增第三个 0–100 `Architecture Score` 并列展示**：2026 年针对 AI 编程仓库的实证研究表明，按代码行数归一化的密度/总分容易因 AI 扩写代码产生“分母稀释错觉”（绝对坏味道未降、密度反而下降），反而不如绝对违例数与 PR 净增变化诚实。
- **独立 `architecture` 报告段 + `Risk Score` 乘数 + 确定性 `Boundary Violation` 门禁（已采纳）**：保持 `Trust Score` 语义纯粹，同时能通过“高扇入 × 高变更 × 低证据”的 `Unstable Hub` 交叉视角突出传统架构工具与测试工具各自看不到的最高危腐化源。

## Consequences

- `Trust Score`、`Doc Trust Score` 与五态行数统计在开启 `--arch` 前后完全一致。
- CI 硬门禁（`--fail-on arch-violation` 及 `--diff` 下的 `--fail-on regression`）仅针对 100% 确定性的未豁免 `Boundary Violation` 触发；认知复杂度、`Implicit Coupling` 与 `Unstable Hub` 等启发式信号只用于风险排序与提示，不作为默认阻断条件。
- 仓库可通过 `Architecture Contract` 中的 `baseline` 豁免存量违例，确保门禁只阻断新增架构退化。
