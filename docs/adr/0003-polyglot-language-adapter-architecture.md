# 采用多语言适配器接缝（LanguageAdapter）与内置零二进制语法分析引擎

为将 `codefog` 的五态证据模型从 TypeScript/JavaScript 扩展至 Go、Rust 与 Java 并支持多语言混合仓库（Polyglot Repo），我们决定在核心分析引擎与具体语言语法之间引入统一的 `LanguageAdapter` 接缝（Seam）：五态判定、`Trust Score`、`Risk Score`、`Fog Map` 渲染与 Git 时间线对比保持完全语言无关；各语言的函数边界切分（含剥离 Rust 同文件 `#[cfg(test)]` 内联测试）、运行时去注释指纹提取、`Outcome Assertion` 与 `Liveness Check` 识别、以及 `codefog verify --mutants` 的类型合法零值变异与编译错误豁免，均由各自的 `LanguageAdapter` 实现（TS/JS 使用 TypeScript Compiler API，Go/Rust/Java 使用内置零二进制依赖的结构化词法与语法扫描器）。

## Considered Options

- **调用宿主机外部语言工具链（`go`、`rustc`、`javac` 子进程）**：要求运行 `npx @barryzhu/codefog` 的环境预装所有目标语言的编译器，破坏了 CI 与本地零配置即跑的体验。
- **打包多语言 Tree-sitter `.wasm` 二进制文件**：需在 npm 包中分发数 MB 的各语言 `.wasm` 资产，增加包体积与跨环境路径加载复杂度。
- **统一 `LanguageAdapter` 接缝 + 内置零二进制结构化词法/语法分析器（已采纳）**：保持 ~70 KB 极小 npm 分发体积与毫秒级冷启动，同时支持 LCOV、Go `coverprofile`、JaCoCo XML 自动识别及 Stryker / PITest / `cargo-mutants` 变异报告摄取。
