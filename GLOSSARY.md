# Codefog

将代码库渲染为信任与风险地图，暴露缺乏有效测试验证的区域（雾）以及验证失效的区域（回雾），为人类开发者与 AI 编码代理提供可闭环的验证目标。

## 证据状态（Evidence States）

**Evidence（证据）**:
证明某段代码行为符合预期的可验证测试事实，其强度取决于断言质量、变异存活率以及相对于代码变更的新鲜度。
_Avoid_: Coverage（覆盖率）, Proof（绝对证明）

**Fog Returned（回雾 / 雾回归）**:
曾处于已验证状态、但随后发生逻辑改动且尚未被有效新证据重新证实的代码区域；代表最高优先级的信任退化事件。
_Avoid_: Regression（回归缺陷）, Stale Code（陈旧代码）

**Fog（雾）**:
没有任何测试执行或验证证据覆盖的未知代码区域。
_Avoid_: Uncovered Code（未覆盖代码）, Dead Code（死代码）

**Self-proof Fog（自证雾）**:
业务实现与其唯一关联测试在同一次提交或同一次生成会话中诞生、尚未经过独立变异或伪测试检验的代码区域。
_Avoid_: Self-certified（自认证）, Co-committed（同提交）

**Weak Evidence（弱证据）**:
已被测试执行，但缺乏实质断言、分支未完全覆盖或存在存活变异体的代码区域（即“假光”）。
_Avoid_: Faint（微光）, Fake Light（假光）, Cracked（裂纹）

**Verified（已验证）**:
具备实质性测试断言或通过变异测试证实、且证据相对于最新代码改动保持新鲜的可信代码区域。
_Avoid_: Bright（明亮）, Lighthouse（灯塔）, Tested（已测试）

## 地图与待办（Map & Findings）

**Fog Map（雾图）**:
按四层渐进披露（Level 1 仓库 → Level 2 模块 → Level 3 文件树图 → Level 4 代码与发现项）可视化代码库证据状态与风险分布的视图，将已验证区域退化为背景并凸显未验证与回雾区域。
_Avoid_: Coverage Report（覆盖率报告）, Heatmap（热力图）

**Hotspot（雾热点）**:
仓库或模块中 `Risk Score` 最高、最亟需补齐验证证据的顶部文件或子目录。
_Avoid_: High-risk File（高危文件）, Bottleneck（瓶颈）

**Finding（发现项 / 验证待办）**:
定位到具体源码文件与行区间的可操作信任缺口，包含确定性标识、证据事实、建议动作与可自动执行的验收条件。
_Avoid_: Issue（问题）, Warning（警告）, Lint Error（静态检查错误）

## 度量与检验指标（Metrics & Verification）

**Trust Score（信任分）**:
衡量整个仓库或模块整体可信程度的聚合指标（0–100），反映有效证据对代码库的覆盖健康度。
_Avoid_: Coverage Percentage（覆盖率百分比）, Quality Score（质量分）

**Risk Score（风险分）**:
衡量单个文件、模块或 `Finding` 行动紧迫度的排序指标（0–10），由未验证代码规模、变更频率（Churn）与圈复杂度共同决定，并对 `Fog Returned` 赋予最高权重。
_Avoid_: Priority（优先级）, Severity（严重度）

**Freshness（新鲜度）**:
测试证据相对于被测代码最新逻辑变更的时间有效性；证据一旦落后于代码变更即发生衰减（Decay）。
_Avoid_: Recency（近期性）, Age（库龄）

**Checked Coverage（检验覆盖）**:
被测试执行且实际影响到断言评估结果的语句比例。
_Avoid_: Line Coverage（行覆盖率）, Assertion Count（断言数）

**Outcome Assertion（结果断言）**:
对被测函数返回的具体业务值、状态变更或预期错误类型进行明确校验的断言，是构成 `Verified` 状态与 `Checked Coverage` 的必要证据。
_Avoid_: Value Check（值检查）, Strong Assertion（强断言）

**Liveness Check（存活性检查）**:
仅验证代码执行未崩溃、返回值非空或未抛出异常的浅层检查，无法证明业务逻辑正确性，仅能归类为 `Weak Evidence`。
_Avoid_: Smoke Check（冒烟检查）, Weak Assertion（弱断言）

**Pseudo-tested Method（伪测试方法）**:
被测试执行过，但即使清空整个函数体或替换为默认返回值，现有测试套件依然全部通过的方法。
_Avoid_: Untested Method（未测方法）, Partially Tested Method（部分测试方法）

**Surviving Mutant（存活变异体）**:
对源码注入微小逻辑变异后，未能使任何测试失败的变异实例，直接证明当前测试对该逻辑分支缺乏有效断言。
_Avoid_: Escaped Bug（逃逸缺陷）, Uncovered Branch（未覆盖分支）
