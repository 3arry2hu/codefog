import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import ts from "typescript";
import { countTsJsOutcomeAssertions } from "./ast-evidence.js";
import type { DocBlock, PackageManifestInfo, RepoSymbolIndex } from "./doc-claims.js";
import { createDeterministicFindingId } from "./scoring.js";
import type { DocClaim, DocReferent, EvidenceState } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Hard safety deny-list: shell/console fenced blocks must NEVER be executed,
 * even when `--run-docs` is enabled.
 */
export const NEVER_EXECUTE_DOC_LANGUAGES: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "shell",
  "console",
  "zsh",
  "fish",
  "cmd",
  "powershell",
  "ps1",
  "bat",
]);

export interface DocCodeBlockRunContext {
  rootDir: string;
  docFile: string;
  language: string;
  code: string;
  startLine: number;
  endLine: number;
  pkgInfo?: PackageManifestInfo;
  symbolIndex?: RepoSymbolIndex;
  timeoutMs?: number;
}

export interface DocCodeBlockRunResult {
  passed: boolean;
  assertionsOnOutcome: number;
  executionOutput?: string;
}

export interface DocCodeBlockRunner {
  readonly id: "ts" | "go" | "rust" | "java";
  readonly languages: readonly string[];
  detectOutcomeAssertions(code: string): number;
  runCodeBlock(ctx: DocCodeBlockRunContext): Promise<DocCodeBlockRunResult>;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function stripTsJsExt(relPath: string): string {
  return relPath.replace(/\.(?:tsx?|jsx?|mjs|cjs)$/i, "");
}

async function collectTsJsSourceFiles(
  dirAbs: string,
  rootDir: string,
  out: string[] = [],
): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dirAbs, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (
      entry.name === "node_modules" ||
      entry.name === ".git" ||
      entry.name === "vendor" ||
      entry.name === "dist" ||
      entry.name === "coverage" ||
      entry.name === ".codefog" ||
      entry.name === "target" ||
      entry.name === "build"
    ) {
      continue;
    }
    const full = path.join(dirAbs, entry.name);
    const rel = toPosix(path.relative(rootDir, full));
    if (entry.isDirectory()) {
      await collectTsJsSourceFiles(full, rootDir, out);
    } else if (
      entry.isFile() &&
      /\.(?:ts|tsx|js|jsx|mjs|cjs)$/i.test(entry.name) &&
      !entry.name.endsWith(".d.ts") &&
      !/\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)$/i.test(entry.name) &&
      !/(?:^|\/)tests?\//.test(rel)
    ) {
      out.push(rel);
    }
  }
  return out;
}

function extractExportedValueNames(sourceText: string, fileName: string): string[] {
  const sf = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") || fileName.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const names = new Set<string>();

  function hasExportModifier(node: ts.Node): boolean {
    if (!ts.canHaveModifiers(node)) return false;
    const mods = ts.getModifiers(node);
    return Boolean(mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
  }

  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && hasExportModifier(stmt)) {
      names.add(stmt.name.text);
    } else if (ts.isClassDeclaration(stmt) && stmt.name && hasExportModifier(stmt)) {
      names.add(stmt.name.text);
    } else if (ts.isEnumDeclaration(stmt) && stmt.name && hasExportModifier(stmt)) {
      names.add(stmt.name.text);
    } else if (ts.isVariableStatement(stmt) && hasExportModifier(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          names.add(decl.name.text);
        }
      }
    } else if (
      ts.isExportDeclaration(stmt) &&
      !stmt.isTypeOnly &&
      stmt.exportClause &&
      ts.isNamedExports(stmt.exportClause)
    ) {
      for (const el of stmt.exportClause.elements) {
        if (!el.isTypeOnly) {
          names.add(el.name.text);
        }
      }
    }
  }

  return Array.from(names);
}

function rewriteModuleSpecifiers(
  sourceText: string,
  currentFileRelInExecDir: string,
  execDir: string,
  knownStems: Set<string>,
  selfPkgNames: Set<string>,
): string {
  const currentDir = path.posix.dirname(toPosix(currentFileRelInExecDir));

  function resolveSpec(rawSpec: string): string {
    const spec = rawSpec.trim();
    for (const pkgName of selfPkgNames) {
      if (spec === pkgName) {
        const relToEntry = toPosix(path.posix.relative(currentDir, "__pkg_entry__.js"));
        return relToEntry.startsWith(".") ? relToEntry : `./${relToEntry}`;
      }
      if (spec.startsWith(`${pkgName}/`)) {
        const sub = spec.slice(pkgName.length + 1);
        const candidates = [
          stripTsJsExt(sub),
          `src/${stripTsJsExt(sub)}`,
          `${stripTsJsExt(sub)}/index`,
          `src/${stripTsJsExt(sub)}/index`,
        ];
        for (const cand of candidates) {
          if (knownStems.has(cand)) {
            const relTarget = toPosix(path.posix.relative(currentDir, `${cand}.js`));
            return relTarget.startsWith(".") ? relTarget : `./${relTarget}`;
          }
        }
      }
    }

    if (spec.startsWith("./") || spec.startsWith("../")) {
      const joined = path.posix.normalize(path.posix.join(currentDir, spec));
      const stem = stripTsJsExt(joined);
      if (knownStems.has(stem)) {
        const relTarget = toPosix(path.posix.relative(currentDir, `${stem}.js`));
        return relTarget.startsWith(".") ? relTarget : `./${relTarget}`;
      }
      if (knownStems.has(`${stem}/index`)) {
        const relTarget = toPosix(path.posix.relative(currentDir, `${stem}/index.js`));
        return relTarget.startsWith(".") ? relTarget : `./${relTarget}`;
      }
      if (/\.(?:ts|tsx|jsx|mts|cts)$/i.test(spec)) {
        return spec.replace(/\.(?:ts|tsx|jsx|mts|cts)$/i, ".js");
      }
    }

    return rawSpec;
  }

  // Rewrite static import/export specifiers and dynamic import() specifiers
  return sourceText
    .replace(
      /(\b(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["'])([^"']+)(["'])/g,
      (_full, prefix: string, spec: string, suffix: string) =>
        `${prefix}${resolveSpec(spec)}${suffix}`,
    )
    .replace(
      /(\bimport\s*\(\s*["'])([^"']+)(["']\s*\))/g,
      (_full, prefix: string, spec: string, suffix: string) =>
        `${prefix}${resolveSpec(spec)}${suffix}`,
    );
}

function instrumentCodeBlockForExecution(
  rawCode: string,
  exportedRepoSymbols: Set<string>,
  selfPkgPrimaryName: string,
): string {
  const sf = ts.createSourceFile(
    "block.ts",
    rawCode,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );

  const declaredOrImported = new Set<string>();
  const nonTypeImportedLocalNames: string[] = [];
  const usedIdentifiers = new Set<string>();

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && stmt.importClause) {
      const isTypeOnlyClause = stmt.importClause.isTypeOnly;
      if (stmt.importClause.name) {
        const local = stmt.importClause.name.text;
        declaredOrImported.add(local);
        if (!isTypeOnlyClause) nonTypeImportedLocalNames.push(local);
      }
      const nb = stmt.importClause.namedBindings;
      if (nb) {
        if (ts.isNamespaceImport(nb)) {
          declaredOrImported.add(nb.name.text);
          if (!isTypeOnlyClause) nonTypeImportedLocalNames.push(nb.name.text);
        } else if (ts.isNamedImports(nb)) {
          for (const el of nb.elements) {
            declaredOrImported.add(el.name.text);
            if (!isTypeOnlyClause && !el.isTypeOnly) {
              nonTypeImportedLocalNames.push(el.name.text);
            }
          }
        }
      }
    } else if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      declaredOrImported.add(stmt.name.text);
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      declaredOrImported.add(stmt.name.text);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          declaredOrImported.add(decl.name.text);
        }
      }
    }
  }

  function collectUsedIds(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) return;
    if (ts.isIdentifier(node)) {
      usedIdentifiers.add(node.text);
    }
    ts.forEachChild(node, collectUsedIds);
  }
  collectUsedIds(sf);

  const preludeLines: string[] = [];
  if (usedIdentifiers.has("assert") && !declaredOrImported.has("assert")) {
    preludeLines.push('import assert from "node:assert";');
  }

  const autoImportSymbols: string[] = [];
  for (const id of usedIdentifiers) {
    if (!declaredOrImported.has(id) && exportedRepoSymbols.has(id)) {
      autoImportSymbols.push(id);
    }
  }
  if (autoImportSymbols.length > 0) {
    preludeLines.push(
      `import { ${autoImportSymbols.join(", ")} } from "${selfPkgPrimaryName}";`,
    );
  }

  // Reference non-type imported bindings so TypeScript transpileModule does not elide them
  const keepImportsLine =
    nonTypeImportedLocalNames.length > 0
      ? `\nvoid [${nonTypeImportedLocalNames.join(", ")}];`
      : "";

  return [
    ...preludeLines,
    rawCode,
    keepImportsLine,
  ]
    .filter(Boolean)
    .join("\n");
}

function summarizeExecutionFailure(rawOutput: string): string {
  const lines = rawOutput
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return "Code block execution failed with non-zero exit code.";
  }
  const priorityLine = lines.find((l) =>
    /(?:AssertionError|SyntaxError|ReferenceError|TypeError|Error:|ERR_|does not provide an export|Cannot find module)/i.test(
      l,
    ),
  );
  const summary = priorityLine
    ? lines.slice(lines.indexOf(priorityLine), lines.indexOf(priorityLine) + 3).join(" | ")
    : lines.slice(0, 3).join(" | ");
  return summary.slice(0, 300);
}

// ============================================================================
// TypeScript / JavaScript Doc Code Block Runner (#22)
// ============================================================================

export const tsJsDocCodeBlockRunner: DocCodeBlockRunner = {
  id: "ts",
  languages: ["ts", "typescript", "js", "javascript"],
  detectOutcomeAssertions: (code) => countTsJsOutcomeAssertions(code),
  runCodeBlock: async (ctx) => {
    const assertionsOnOutcome = countTsJsOutcomeAssertions(ctx.code);
    const timeoutMs = ctx.timeoutMs ?? 5000;

    // 1. Check for syntactic diagnostics before running
    const preCheck = ts.transpileModule(ctx.code, {
      fileName: `block.${ctx.language.startsWith("j") ? "js" : "ts"}`,
      reportDiagnostics: true,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
    });
    const syntaxErrors = (preCheck.diagnostics ?? []).filter(
      (d) => d.category === ts.DiagnosticCategory.Error,
    );
    if (syntaxErrors.length > 0) {
      const msg = syntaxErrors
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))
        .join("; ");
      return {
        passed: false,
        assertionsOnOutcome,
        executionOutput: `Transpile error: ${msg}`,
      };
    }

    const execDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefog-rundocs-ts-"));
    try {
      await fs.writeFile(
        path.join(execDir, "package.json"),
        JSON.stringify({ type: "module" }, null, 2),
        "utf8",
      );

      // Symlink node_modules from rootDir if available so external packages resolve
      try {
        const rootNodeModules = path.join(ctx.rootDir, "node_modules");
        await fs.access(rootNodeModules);
        await fs.symlink(rootNodeModules, path.join(execDir, "node_modules"), "dir");
      } catch {
        // optional
      }

      const sourceFiles = await collectTsJsSourceFiles(ctx.rootDir, ctx.rootDir);
      const knownStems = new Set<string>();
      for (const rel of sourceFiles) {
        knownStems.add(stripTsJsExt(rel));
      }

      const selfPkgNames = new Set<string>(["@barryzhu/codefog"]);
      if (ctx.pkgInfo?.packageName) {
        selfPkgNames.add(ctx.pkgInfo.packageName);
      } else {
        try {
          const pkgRaw = await fs.readFile(path.join(ctx.rootDir, "package.json"), "utf8");
          const pkgJson = JSON.parse(pkgRaw) as { name?: string };
          if (pkgJson.name) selfPkgNames.add(pkgJson.name);
        } catch {
          // ignore
        }
      }
      const selfPkgPrimaryName = ctx.pkgInfo?.packageName ?? "@barryzhu/codefog";

      const exportedByStem = new Map<string, string[]>();
      const allExportedSymbols = new Set<string>();

      for (const rel of sourceFiles) {
        const srcText = await fs.readFile(path.join(ctx.rootDir, rel), "utf8");
        const stem = stripTsJsExt(rel);
        const exportsInFile = extractExportedValueNames(srcText, rel);
        exportedByStem.set(stem, exportsInFile);
        for (const sym of exportsInFile) {
          allExportedSymbols.add(sym);
        }

        const rewrittenSrc = rewriteModuleSpecifiers(
          srcText,
          `${stem}.js`,
          execDir,
          knownStems,
          selfPkgNames,
        );
        const transpiled = ts.transpileModule(rewrittenSrc, {
          fileName: rel,
          compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
          },
        });
        const outPath = path.join(execDir, `${stem}.js`);
        await fs.mkdir(path.dirname(outPath), { recursive: true });
        await fs.writeFile(outPath, transpiled.outputText, "utf8");
      }

      // Build __pkg_entry__.js re-exporting primary entry and any additional repo exports
      const entryLines: string[] = [];
      const primaryEntryStems = ["src/index", "index"];
      const primaryStem = primaryEntryStems.find((s) => knownStems.has(s));
      if (primaryStem) {
        entryLines.push(`export * from "./${primaryStem}.js";`);
      }
      const alreadyExported = new Set<string>(
        primaryStem ? (exportedByStem.get(primaryStem) ?? []) : [],
      );
      for (const [stem, syms] of exportedByStem.entries()) {
        if (stem === primaryStem) continue;
        const uniqueSyms = syms.filter((s) => !alreadyExported.has(s));
        if (uniqueSyms.length > 0) {
          for (const s of uniqueSyms) alreadyExported.add(s);
          entryLines.push(`export { ${uniqueSyms.join(", ")} } from "./${stem}.js";`);
        }
      }
      await fs.writeFile(
        path.join(execDir, "__pkg_entry__.js"),
        entryLines.join("\n") + "\n",
        "utf8",
      );

      // Instrument and transpile the Markdown code block at its docFile relative directory
      const blockRelJs = toPosix(
        path.posix.join(
          path.posix.dirname(toPosix(ctx.docFile)),
          `__doc_block_${ctx.startLine}__.js`,
        ),
      );
      const instrumentedCode = instrumentCodeBlockForExecution(
        ctx.code,
        allExportedSymbols,
        selfPkgPrimaryName,
      );
      const rewrittenBlockCode = rewriteModuleSpecifiers(
        instrumentedCode,
        blockRelJs,
        execDir,
        knownStems,
        selfPkgNames,
      );
      const transpiledBlock = ts.transpileModule(rewrittenBlockCode, {
        fileName: blockRelJs.replace(/\.js$/, ".ts"),
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
        },
      });

      const blockAbsPath = path.join(execDir, blockRelJs);
      await fs.mkdir(path.dirname(blockAbsPath), { recursive: true });
      await fs.writeFile(blockAbsPath, transpiledBlock.outputText, "utf8");

      await execFileAsync(process.execPath, [blockAbsPath], {
        cwd: ctx.rootDir,
        timeout: timeoutMs,
      });

      return {
        passed: true,
        assertionsOnOutcome,
      };
    } catch (err: any) {
      const stderr = typeof err?.stderr === "string" ? err.stderr : "";
      const stdout = typeof err?.stdout === "string" ? err.stdout : "";
      const message = typeof err?.message === "string" ? err.message : String(err);
      const killed = Boolean(err?.killed) || err?.signal === "SIGTERM";
      const rawOut = killed
        ? `Execution timed out after ${timeoutMs}ms. ${stderr || stdout || message}`
        : stderr || stdout || message;
      return {
        passed: false,
        assertionsOnOutcome,
        executionOutput: summarizeExecutionFailure(rawOut),
      };
    } finally {
      await fs.rm(execDir, { recursive: true, force: true });
    }
  },
};

// ============================================================================
// Go Doc Code Block Runner Slot (#26)
// ============================================================================

// Ticket #26 adds `goDocCodeBlockRunner` (`id: "go"`, `languages: ["go"]`) here.

// ============================================================================
// Rust Doc Code Block Runner Slot (#27)
// ============================================================================

// Ticket #27 adds `rustDocCodeBlockRunner` (`id: "rust"`, `languages: ["rust"]`) here.

// ============================================================================
// Java Doc Code Block Runner Slot (#28)
// ============================================================================

// Ticket #28 adds `javaDocCodeBlockRunner` (`id: "java"`, `languages: ["java"]`) here.

// ============================================================================
// Runner Registry & Dispatcher
// ============================================================================

export const DOC_CODE_BLOCK_RUNNERS: DocCodeBlockRunner[] = [
  tsJsDocCodeBlockRunner,
];

export function registerDocCodeBlockRunner(runner: DocCodeBlockRunner): void {
  const existingIdx = DOC_CODE_BLOCK_RUNNERS.findIndex((r) => r.id === runner.id);
  if (existingIdx >= 0) {
    DOC_CODE_BLOCK_RUNNERS[existingIdx] = runner;
  } else {
    DOC_CODE_BLOCK_RUNNERS.push(runner);
  }
}

export function getDocCodeBlockRunner(language: string | undefined): DocCodeBlockRunner | undefined {
  if (!language) return undefined;
  const norm = language.trim().toLowerCase();
  if (!norm || NEVER_EXECUTE_DOC_LANGUAGES.has(norm)) {
    return undefined;
  }
  return DOC_CODE_BLOCK_RUNNERS.find((r) => r.languages.includes(norm));
}

function extractReferencedRepoSymbols(
  code: string,
  symbolIndex: RepoSymbolIndex,
): DocReferent[] {
  const referents: DocReferent[] = [];
  const seenKeys = new Set<string>();
  const idRe = /\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g;
  let m: RegExpExecArray | null;
  while ((m = idRe.exec(code)) !== null) {
    const token = m[1]!;
    const matches = symbolIndex.byName.get(token);
    if (!matches || matches.length === 0) continue;
    for (const sym of matches) {
      const key = `${sym.file}:${sym.name}:${sym.startLine}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      referents.push({
        kind: "symbol",
        file: sym.file,
        symbol: sym.name,
        startLine: sym.startLine,
        endLine: sym.endLine,
        runtimeFingerprint: sym.runtimeFingerprint,
      });
    }
  }
  return referents;
}

export async function evaluateDocCodeBlockClaim(params: {
  rootDir: string;
  docFile: string;
  block: DocBlock;
  runDocs: boolean;
  symbolIndex: RepoSymbolIndex;
  pkgInfo: PackageManifestInfo;
}): Promise<DocClaim | null> {
  const { rootDir, docFile, block, runDocs, symbolIndex, pkgInfo } = params;
  if (block.kind !== "code-block" || block.ignored) return null;

  const lang = (block.language ?? "").trim().toLowerCase();
  if (!lang || NEVER_EXECUTE_DOC_LANGUAGES.has(lang)) {
    return null;
  }

  const runner = getDocCodeBlockRunner(lang);
  if (!runner) {
    return null;
  }

  const code = block.codeContent ?? "";
  const referents = extractReferencedRepoSymbols(code, symbolIndex);
  const claimId = createDeterministicFindingId(
    docFile,
    `${block.startLine}:code-block:${lang}`,
  );
  const target = `${lang}:${block.startLine}-${block.endLine}`;
  const text = `${lang} code block (${docFile}:${block.startLine}-${block.endLine})`;

  if (!runDocs) {
    return {
      id: claimId,
      file: docFile,
      kind: "code-block",
      text,
      rawText: block.rawText,
      target,
      startLine: block.startLine,
      endLine: block.endLine,
      blockKind: "code-block",
      blockStartLine: block.startLine,
      blockEndLine: block.endLine,
      state: "fog",
      referents,
      ...(referents[0] ? { referent: referents[0] } : {}),
    };
  }

  const runRes = await runner.runCodeBlock({
    rootDir,
    docFile,
    language: lang,
    code,
    startLine: block.startLine,
    endLine: block.endLine,
    pkgInfo,
    symbolIndex,
  });

  let state: EvidenceState;
  if (!runRes.passed) {
    state = "fog-returned";
  } else if (runRes.assertionsOnOutcome > 0) {
    state = "verified";
  } else {
    state = "weak-evidence";
  }

  return {
    id: claimId,
    file: docFile,
    kind: "code-block",
    text,
    rawText: block.rawText,
    target,
    startLine: block.startLine,
    endLine: block.endLine,
    blockKind: "code-block",
    blockStartLine: block.startLine,
    blockEndLine: block.endLine,
    state,
    referents,
    ...(referents[0] ? { referent: referents[0] } : {}),
    ...(runRes.executionOutput ? { executionOutput: runRes.executionOutput } : {}),
  };
}
