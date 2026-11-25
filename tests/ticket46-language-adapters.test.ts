import { describe, expect, it } from "vitest";
import { getLanguageAdapter, LANGUAGE_ADAPTERS } from "../src/index.js";
import { getPolyglotAdapter, POLYGLOT_LANGUAGE_ADAPTERS } from "../src/polyglot.js";

describe("four-language adapters", () => {
  it("keeps the polyglot export while registering TS/JS in the common interface", () => {
    expect(LANGUAGE_ADAPTERS.map(({ id }) => id)).toEqual(["ts", "go", "rust", "java"]);
    expect(POLYGLOT_LANGUAGE_ADAPTERS.map(({ id }) => id)).toEqual(["go", "rust", "java"]);
    expect(getPolyglotAdapter("app.ts")).toBeUndefined();
    expect(getLanguageAdapter("app.jsx")?.id).toBe("ts");
  });

  it("resolves TS/JS type imports, JS extensions, re-exports and require to tracked files", () => {
    const file = "src/routes/page.ts";
    const text = [
      "import type { Data } from '../db/model.js';",
      "export { repo } from '../db';",
      "const policy = require('./policy.cjs');",
      "import fs from 'node:fs';",
      "const fake = \"import ignored from '../ignored';\";",
      "import type { Utility } from 'external/utils';",
      "type C = import('../db/types').C;",
    ].join("\n");
    const files = new Set([file, "src/db/model.ts", "src/db/index.ts", "src/routes/policy.cjs", "src/db/types.ts", "src/ignored.ts"]);
    expect(getLanguageAdapter(file)!.extractFileDependencies(text, file, files)).toEqual([
      { from: file, to: "src/db/model.ts", line: 1 },
      { from: file, to: "src/db/index.ts", line: 2 },
      { from: file, to: "src/routes/policy.cjs", line: 3 },
      { from: file, to: "src/db/types.ts", line: 7 },
    ]);
  });

  it("resolves Go import groups with the nearest repository module prefix", () => {
    const file = "cmd/tool/main.go";
    const text = [
      "package main",
      "import (",
      '    "fmt"',
      '    _ "example.com/group/app"',
      '    foo "example.com/group/app/db"',
      '    . "example.com/group/app/sub/mod"',
      '    "example.com/other"',
      ")",
    ].join("\n");
    const files = new Set([file, "app.go", "db/model.go", "db/model_test.go", "modules/sub/mod.go"]);
    const sourceTexts = new Map([
      ["go.mod", "module example.com/group/app"],
      ["modules/sub/go.mod", "module example.com/group/app/sub/mod"],
    ]);
    expect(getLanguageAdapter(file)!.extractFileDependencies(text, file, files, { sourceTexts })).toEqual([
      { from: file, to: "app.go", line: 4 },
      { from: file, to: "db/model.go", line: 5 },
      { from: file, to: "modules/sub/mod.go", line: 6 },
    ]);
  });

  it("resolves Rust sibling modules, grouped paths and aliased Cargo path dependencies", () => {
    const file = "crates/api/src/routes.rs";
    const text = [
      "mod helper;",
      "use super::context::Request;",
      "use crate::{db::{self, Model}, config::Store};",
      "use model_crate::data::Export;",
      "use workspace_model::data::Export;",
      "use std::collections::HashMap;",
      "#[cfg(test)] mod tests { use crate::test_support::Fixture; }",
    ].join("\n");
    const files = new Set([
      file,
      "crates/api/src/lib.rs",
      "crates/api/src/routes/helper.rs",
      "crates/api/src/context.rs",
      "crates/api/src/db/mod.rs",
      "crates/api/src/config.rs",
      "crates/api/src/test_support.rs",
      "crates/library/src/lib.rs",
      "crates/library/src/data.rs",
      "crates/model/src/lib.rs",
      "crates/model/src/data.rs",
    ]);
    const sourceTexts = new Map([
      ["Cargo.toml", '[workspace]\nmembers = ["crates/api", "crates/library", "crates/model"]\n[workspace.dependencies]\nworkspace-model = { package = "model", path = "crates/model" }'],
      ["crates/api/Cargo.toml", '[package]\nname = "api"\n[dependencies]\nmodel-crate = { path = "../library" }\nworkspace-model.workspace = true'],
      ["crates/library/Cargo.toml", '[package]\nname = "storage"'],
      ["crates/model/Cargo.toml", '[package]\nname = "model"'],
    ]);
    expect(getLanguageAdapter(file)!.extractFileDependencies(text, file, files, { sourceTexts })).toEqual([
      { from: file, to: "crates/api/src/routes/helper.rs", line: 1 },
      { from: file, to: "crates/api/src/context.rs", line: 2 },
      { from: file, to: "crates/api/src/db/mod.rs", line: 3 },
      { from: file, to: "crates/api/src/config.rs", line: 3 },
      { from: file, to: "crates/library/src/data.rs", line: 4 },
      { from: file, to: "crates/model/src/data.rs", line: 5 },
    ]);
  });

  it("resolves Java package imports using source declarations and maps static and wildcard imports", () => {
    const file = "services/routes/src/main/java/Routes.java";
    const text = [
      "package com.app.routes;",
      "import com.app.model.Record;",
      "import static com.app.db.Repository.lookup;",
      "import com.app.util.*;",
      "import java.util.*;",
      "import other.lib.Class;",
    ].join("\n");
    const sourceTexts = new Map([
      [file, text],
      ["services/store/code/Record.java", "package com.app.model; class Record {}"],
      ["services/store/code/Repository.java", "package com.app.db; class Repository {}"],
      ["services/store/code/Helper.java", "package com.app.util; class Helper {}"],
    ]);
    const files = new Set(sourceTexts.keys());
    expect(getLanguageAdapter(file)!.extractFileDependencies(text, file, files, { sourceTexts })).toEqual([
      { from: file, to: "services/store/code/Record.java", line: 2 },
      { from: file, to: "services/store/code/Repository.java", line: 3 },
      { from: file, to: "services/store/code/Helper.java", line: 4 },
    ]);
  });

  it.each([
    {
      file: "src/a.ts",
      source: "function f(x: number) {\n if (x) {\n  for (let i = 0; i < x; i++) {\n   switch (i) { case 0: break; }\n  }\n }\n try { f(0); } catch { /* intentionally blank */ }\n}",
      expected: { cognitiveComplexity: 8, maxNestingDepth: 3, errorMaskingLines: [7] },
    },
    {
      file: "src/a.go",
      source: "package a\nfunc f(x int, err error) {\n if x > 0 {\n  for i := 0; i < x; i++ {\n   switch i { case 0: break }\n  }\n }\n _ = err\n if err != nil { /* ignored */ }\n}",
      expected: { cognitiveComplexity: 7, maxNestingDepth: 3, errorMaskingLines: [8, 9] },
    },
    {
      file: "src/a.rs",
      source: "fn f(x: i32) {\n if x > 0 {\n  for i in 0..x {\n   match i { _ => continue }\n  }\n }\n x.checked_add(1).unwrap();\n}\n#[cfg(test)] mod tests { fn sample() { Some(1).expect(\"ok\"); } }",
      expected: { cognitiveComplexity: 6, maxNestingDepth: 3, errorMaskingLines: [7] },
    },
    {
      file: "src/A.java",
      source: "class A {\n void f(int x) {\n  if (x > 0)\n   for (int i = 0; i < x; i++)\n    switch (i) { case 0: break; }\n  try { log(); } catch (Exception e) { /* ignored */ }\n }\n}",
      expected: { cognitiveComplexity: 7, maxNestingDepth: 3, errorMaskingLines: [6] },
    },
  ])("counts nested decisions and masking for $file", ({ file, source, expected }) => {
    const adapter = getLanguageAdapter(file)!;
    const [span] = adapter.extractFunctionSpans(source, file);
    expect(span?.name).toBe("f");
    expect(adapter.analyzeFunctionStructure(source, span!, file)).toEqual(expected);
  });

  it("does not flag Rust assertions in integration test files", () => {
    const file = "crates/tools/tests/check.rs";
    const source = 'fn check() { Some(5).expect("ok"); }';
    expect(getLanguageAdapter(file)?.analyzeFunctionStructure(source, { startLine: 1, endLine: 1 }, file)).toEqual({
      cognitiveComplexity: 0,
      maxNestingDepth: 0,
      errorMaskingLines: [],
    });
  });

  it("ignores Rust raw strings and nested comments while respecting a standalone test-only item", () => {
    const file = "src/lib.rs";
    const source = [
      "#[cfg(test)] mod tests;",
      "fn work() {",
      '  let _ = r#"a quote \" and a fake .unwrap() and use crate::decoy::Module;"#;',
      "  /* outer /* inner */ another fake .unwrap() */",
      "  Some(5).unwrap();",
      "}",
    ].join("\n");
    const adapter = getLanguageAdapter(file)!;
    expect(adapter.extractFileDependencies(source, file, new Set([file, "src/tests.rs", "src/decoy.rs"]))).toEqual([]);
    const [span] = adapter.extractFunctionSpans(source, file);
    expect(span?.name).toBe("work");
    expect(adapter.analyzeFunctionStructure(source, span!, file).errorMaskingLines).toEqual([5]);
  });
});
