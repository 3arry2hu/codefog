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

import {
  countGoOutcomeAssertions,
  findFilesByExtensionInRepo,
} from "./polyglot.js";

const GO_STDLIB_BY_QUALIFIER: ReadonlyMap<string, string> = new Map([
  ["fmt", "fmt"],
  ["reflect", "reflect"],
  ["errors", "errors"],
  ["strings", "strings"],
  ["bytes", "bytes"],
  ["slices", "slices"],
  ["maps", "maps"],
  ["os", "os"],
  ["io", "io"],
  ["log", "log"],
  ["strconv", "strconv"],
  ["math", "math"],
  ["time", "time"],
  ["sort", "sort"],
  ["context", "context"],
  ["regexp", "regexp"],
  ["sync", "sync"],
  ["filepath", "path/filepath"],
  ["json", "encoding/json"],
  ["http", "net/http"],
  ["utf8", "unicode/utf8"],
]);

interface GoRepoPackageMeta {
  pkgName: string;
  importPath: string;
  relDir: string;
  exportedSymbols: Set<string>;
}

function extractGoExportedNames(sourceText: string): Set<string> {
  const { noComments, masked } = stripCommentsAndMaskStrings(sourceText);
  const exported = new Set<string>();

  // Top-level functions (not methods with receivers)
  const funcRe = /^[ \t]*func[ \t]+([A-Z][A-Za-z0-9_]*)[ \t]*[\[/(]/gm;
  let m: RegExpExecArray | null;
  while ((m = funcRe.exec(masked)) !== null) {
    if (m[1]) exported.add(m[1]);
  }

  // Exported types
  const typeRe = /^[ \t]*type[ \t]+([A-Z][A-Za-z0-9_]*)\b/gm;
  while ((m = typeRe.exec(noComments)) !== null) {
    if (m[1]) exported.add(m[1]);
  }

  // Exported single-line var/const
  const varConstRe = /^[ \t]*(?:var|const)[ \t]+([A-Z][A-Za-z0-9_]*)\b/gm;
  while ((m = varConstRe.exec(noComments)) !== null) {
    if (m[1]) exported.add(m[1]);
  }

  return exported;
}

function renameMainFuncInGoSource(sourceText: string): string {
  const { masked } = stripCommentsAndMaskStrings(sourceText);
  const mainRe = /^([ \t]*func[ \t]+)main([ \t]*\(\s*\))/gm;
  const m = mainRe.exec(masked);
  if (!m) return sourceText;
  const prefixLen = m[1]!.length;
  const nameStart = m.index + prefixLen;
  const nameEnd = nameStart + 4;
  return (
    sourceText.slice(0, nameStart) + "_codefogOrigMain" + sourceText.slice(nameEnd)
  );
}

function wrapGoDocCodeBlock(
  rawCode: string,
  repoPackagesByName: Map<string, GoRepoPackageMeta>,
  repoPackagesList: GoRepoPackageMeta[],
): string {
  const { noComments, masked } = stripCommentsAndMaskStrings(rawCode);

  const spansToRemove: Array<{ start: number; end: number }> = [];
  const explicitImports: Array<{ alias?: string; path: string; rawSpec: string }> = [];

  // 1. Strip existing `package <name>` declaration if present
  const pkgMatch = /^[ \t]*package[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*(?:;|\r?\n|$)/m.exec(
    noComments,
  );
  if (pkgMatch) {
    spansToRemove.push({
      start: pkgMatch.index,
      end: pkgMatch.index + pkgMatch[0].length,
    });
  }

  // 2. Extract parenthesized `import ( ... )` blocks
  const importBlockRe = /^[ \t]*import[ \t]*\(/gm;
  let ibm: RegExpExecArray | null;
  while ((ibm = importBlockRe.exec(masked)) !== null) {
    const openParenIdx = masked.indexOf("(", ibm.index);
    if (openParenIdx === -1) continue;
    const closeParenIdx = findMatchingDelimiter(masked, openParenIdx, "(", ")");
    if (closeParenIdx === -1) continue;
    spansToRemove.push({ start: ibm.index, end: closeParenIdx + 1 });

    const blockInner = noComments.slice(openParenIdx + 1, closeParenIdx);
    const specRe = /^[ \t]*(?:([A-Za-z_.]\w*)[ \t]+)?"([^"]+)"/gm;
    let sm: RegExpExecArray | null;
    while ((sm = specRe.exec(blockInner)) !== null) {
      const alias = sm[1];
      const impPath = sm[2]!;
      explicitImports.push({
        alias,
        path: impPath,
        rawSpec: alias ? `${alias} "${impPath}"` : `"${impPath}"`,
      });
    }
    importBlockRe.lastIndex = closeParenIdx + 1;
  }

  function isInsideRemovedSpan(idx: number): boolean {
    return spansToRemove.some((s) => idx >= s.start && idx < s.end);
  }

  // 3. Extract single-line `import [alias] "path"` statements
  const singleImportRe = /^[ \t]*import[ \t]+(?:([A-Za-z_.]\w*)[ \t]+)?"([^"]+)"[^\n]*/gm;
  let sim: RegExpExecArray | null;
  while ((sim = singleImportRe.exec(noComments)) !== null) {
    if (isInsideRemovedSpan(sim.index)) continue;
    spansToRemove.push({ start: sim.index, end: sim.index + sim[0].length });
    const alias = sim[1];
    const impPath = sim[2]!;
    explicitImports.push({
      alias,
      path: impPath,
      rawSpec: alias ? `${alias} "${impPath}"` : `"${impPath}"`,
    });
  }

  // Reconstruct body with package and import declarations removed
  const sortedSpans = [...spansToRemove].sort((a, b) => a.start - b.start);
  let remainingBody = "";
  let cursor = 0;
  for (const s of sortedSpans) {
    if (s.start > cursor) {
      remainingBody += rawCode.slice(cursor, s.start);
    }
    cursor = Math.max(cursor, s.end);
  }
  remainingBody += rawCode.slice(cursor);

  const { noComments: bodyNoComments, masked: bodyMasked } =
    stripCommentsAndMaskStrings(remainingBody);

  // Track already-imported package qualifiers and import paths
  const importedQualifiers = new Set<string>();
  const importedPaths = new Set<string>();
  const finalImportSpecs: string[] = [];

  for (const imp of explicitImports) {
    importedPaths.add(imp.path);
    finalImportSpecs.push(imp.rawSpec);
    if (imp.alias && imp.alias !== "." && imp.alias !== "_") {
      importedQualifiers.add(imp.alias);
    } else if (!imp.alias) {
      const segs = imp.path.split("/");
      const lastSeg = segs[segs.length - 1];
      if (lastSeg) importedQualifiers.add(lastSeg);
      for (const pkg of repoPackagesList) {
        if (pkg.importPath === imp.path) {
          importedQualifiers.add(pkg.pkgName);
        }
      }
    }
  }

  // Detect local variables declared in the snippet so we don't confuse them with package names
  const declaredVars = new Set<string>();
  const shortDeclRe = /\b([A-Za-z_][A-Za-z0-9_]*)\s*(?:,\s*[A-Za-z_][A-Za-z0-9_]*)*\s*:=/g;
  let dm: RegExpExecArray | null;
  while ((dm = shortDeclRe.exec(bodyMasked)) !== null) {
    const lhs = dm[0].replace(/:=$/, "");
    for (const part of lhs.split(",")) {
      const v = part.trim();
      if (v) declaredVars.add(v);
    }
  }
  const varDeclRe = /\b(?:var|const)\s+([A-Za-z_][A-Za-z0-9_]*)\b/g;
  while ((dm = varDeclRe.exec(bodyMasked)) !== null) {
    if (dm[1]) declaredVars.add(dm[1]);
  }

  // 4. Auto-import qualified references `<pkg>.<ExportedIdent>`
  const qualifiedRefRe = /\b([a-z][A-Za-z0-9_]*)\s*\.\s*[A-Z][A-Za-z0-9_]*\b/g;
  let qm: RegExpExecArray | null;
  while ((qm = qualifiedRefRe.exec(bodyMasked)) !== null) {
    const qual = qm[1]!;
    if (importedQualifiers.has(qual) || declaredVars.has(qual)) continue;
    const repoPkg = repoPackagesByName.get(qual);
    if (repoPkg && !importedPaths.has(repoPkg.importPath)) {
      importedQualifiers.add(qual);
      importedPaths.add(repoPkg.importPath);
      finalImportSpecs.push(
        repoPkg.pkgName === qual
          ? `"${repoPkg.importPath}"`
          : `${qual} "${repoPkg.importPath}"`,
      );
      continue;
    }
    const stdPath = GO_STDLIB_BY_QUALIFIER.get(qual);
    if (stdPath && !importedPaths.has(stdPath)) {
      importedQualifiers.add(qual);
      importedPaths.add(stdPath);
      finalImportSpecs.push(`"${stdPath}"`);
    }
  }

  // 5. Auto dot-import local repo package if its exported symbol is called bare without qualifier
  for (const pkg of repoPackagesList) {
    if (importedPaths.has(pkg.importPath) || importedQualifiers.has(pkg.pkgName)) {
      continue;
    }
    let usesExportedSymbolBare = false;
    for (const sym of pkg.exportedSymbols) {
      if (declaredVars.has(sym)) continue;
      const bareSymRe = new RegExp(`(?<!\\.)\\b${sym}\\b`);
      if (bareSymRe.test(bodyMasked)) {
        usesExportedSymbolBare = true;
        break;
      }
    }
    if (usesExportedSymbolBare) {
      importedPaths.add(pkg.importPath);
      finalImportSpecs.push(`. "${pkg.importPath}"`);
    }
  }

  // 6. Check if `func main(` already exists; if not, separate any top-level named funcs and wrap statements in `func main()`
  const hasMainFunc = /\bfunc[ \t]+main[ \t]*\(/.test(bodyMasked);
  let assembledMainSection: string;

  if (hasMainFunc) {
    assembledMainSection = remainingBody.trim();
  } else {
    const topFuncs: string[] = [];
    const funcSpans: Array<{ start: number; end: number }> = [];
    const topFuncRe = /^[ \t]*func[ \t]+(?:\([^)]+\)[ \t]*)?[A-Za-z_][A-Za-z0-9_]*[ \t]*(?:\[[^\]]+\][ \t]*)?\(/gm;
    let tfm: RegExpExecArray | null;
    while ((tfm = topFuncRe.exec(bodyMasked)) !== null) {
      const openParen = bodyMasked.indexOf("(", tfm.index + 4);
      if (openParen === -1) continue;
      const closeParen = findMatchingDelimiter(bodyMasked, openParen, "(", ")");
      if (closeParen === -1) continue;
      const openBrace = bodyMasked.indexOf("{", closeParen + 1);
      if (openBrace === -1) continue;
      const closeBrace = findMatchingDelimiter(bodyMasked, openBrace, "{", "}");
      if (closeBrace === -1) continue;
      funcSpans.push({ start: tfm.index, end: closeBrace + 1 });
      topFuncs.push(remainingBody.slice(tfm.index, closeBrace + 1));
      topFuncRe.lastIndex = closeBrace + 1;
    }

    let stmtBody = "";
    let fCursor = 0;
    for (const fsSpan of funcSpans) {
      if (fsSpan.start > fCursor) {
        stmtBody += remainingBody.slice(fCursor, fsSpan.start);
      }
      fCursor = Math.max(fCursor, fsSpan.end);
    }
    stmtBody += remainingBody.slice(fCursor);

    assembledMainSection = [
      ...topFuncs,
      `func main() {\n${stmtBody.trim()}\n}`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  const importSection =
    finalImportSpecs.length > 0
      ? `import (\n${finalImportSpecs.map((s) => `\t${s}`).join("\n")}\n)\n\n`
      : "";

  return `package main\n\n${importSection}${assembledMainSection}\n`;
}

function summarizeGoExecutionFailure(rawOutput: string): string {
  const lines = rawOutput
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => Boolean(l) && !l.startsWith("# "));
  if (lines.length === 0) {
    return "Go code block execution failed with non-zero exit code.";
  }
  const priorityLine = lines.find((l) =>
    /(?:undefined:|cannot use|not enough arguments|too many arguments|syntax error:|panic:|fatal error:|no required module|imported and not used)/i.test(
      l,
    ),
  );
  const summary = priorityLine
    ? lines.slice(lines.indexOf(priorityLine), lines.indexOf(priorityLine) + 3).join(" | ")
    : lines.slice(0, 3).join(" | ");
  return summary.slice(0, 300);
}

async function resolveGoBinary(): Promise<string> {
  try {
    await fs.access("/usr/local/go/bin/go");
    return "/usr/local/go/bin/go";
  } catch {
    return "go";
  }
}

export const goDocCodeBlockRunner: DocCodeBlockRunner = {
  id: "go",
  languages: ["go"],
  detectOutcomeAssertions: (code) => countGoOutcomeAssertions(code),
  runCodeBlock: async (ctx) => {
    const assertionsOnOutcome = countGoOutcomeAssertions(ctx.code);
    const timeoutMs = ctx.timeoutMs ?? 15000;
    const execDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefog-rundocs-go-"));

    try {
      let goModContent = "";
      let modulePath = "codefog.local/docrun";
      try {
        goModContent = await fs.readFile(path.join(ctx.rootDir, "go.mod"), "utf8");
        const m = /^\s*module\s+(\S+)/m.exec(goModContent);
        if (m?.[1]) {
          modulePath = m[1];
        }
      } catch {
        goModContent = `module ${modulePath}\n\ngo 1.22\n`;
      }

      await fs.writeFile(path.join(execDir, "go.mod"), goModContent, "utf8");

      try {
        const goSum = await fs.readFile(path.join(ctx.rootDir, "go.sum"), "utf8");
        await fs.writeFile(path.join(execDir, "go.sum"), goSum, "utf8");
      } catch {
        // optional
      }

      try {
        const rootVendor = path.join(ctx.rootDir, "vendor");
        await fs.access(rootVendor);
        await fs.symlink(rootVendor, path.join(execDir, "vendor"), "dir");
      } catch {
        // optional
      }

      const allGoFiles = await findFilesByExtensionInRepo(ctx.rootDir, ctx.rootDir, ".go");
      const prodGoFiles = allGoFiles.filter(
        (f) => !f.endsWith("_test.go") && !f.endsWith(".pb.go") && !f.endsWith("_gen.go"),
      );

      const repoPackagesByDir = new Map<string, GoRepoPackageMeta>();
      const repoPackagesByName = new Map<string, GoRepoPackageMeta>();
      const rootMainFiles: Array<{ name: string; content: string }> = [];

      for (const rel of prodGoFiles) {
        const srcText = await fs.readFile(path.join(ctx.rootDir, rel), "utf8");
        const destPath = path.join(execDir, rel);
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        await fs.writeFile(destPath, srcText, "utf8");

        const { noComments } = stripCommentsAndMaskStrings(srcText);
        const pkgMatch = /^\s*package\s+([A-Za-z_][A-Za-z0-9_]*)\b/m.exec(noComments);
        const pkgName = pkgMatch?.[1] ?? "main";
        const relDir = toPosix(path.dirname(rel));

        if (pkgName === "main") {
          if (relDir === ".") {
            rootMainFiles.push({
              name: path.basename(rel),
              content: renameMainFuncInGoSource(srcText),
            });
          }
          continue;
        }

        const importPath = relDir === "." ? modulePath : `${modulePath}/${relDir}`;
        let meta = repoPackagesByDir.get(relDir);
        if (!meta) {
          meta = {
            pkgName,
            importPath,
            relDir,
            exportedSymbols: new Set<string>(),
          };
          repoPackagesByDir.set(relDir, meta);
          repoPackagesByName.set(pkgName, meta);
          if (relDir !== ".") {
            const dirBase = path.posix.basename(relDir);
            if (!repoPackagesByName.has(dirBase)) {
              repoPackagesByName.set(dirBase, meta);
            }
          }
        }
        for (const sym of extractGoExportedNames(srcText)) {
          meta.exportedSymbols.add(sym);
        }
      }

      const runnerDir = path.join(execDir, "codefog_doc_runner");
      await fs.mkdir(runnerDir, { recursive: true });

      for (const rf of rootMainFiles) {
        await fs.writeFile(path.join(runnerDir, `root_${rf.name}`), rf.content, "utf8");
      }

      const wrappedGoCode = wrapGoDocCodeBlock(
        ctx.code,
        repoPackagesByName,
        Array.from(repoPackagesByDir.values()),
      );
      await fs.writeFile(path.join(runnerDir, "main.go"), wrappedGoCode, "utf8");

      const goBin = await resolveGoBinary();
      const envPath = process.env.PATH
        ? `/usr/local/go/bin:${process.env.PATH}`
        : "/usr/local/go/bin:/usr/bin:/bin";

      await execFileAsync(goBin, ["run", "./codefog_doc_runner"], {
        cwd: execDir,
        timeout: timeoutMs,
        env: {
          ...process.env,
          PATH: envPath,
          GOPROXY: "off",
          GOTOOLCHAIN: "local",
        },
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
        executionOutput: summarizeGoExecutionFailure(rawOut),
      };
    } finally {
      await fs.rm(execDir, { recursive: true, force: true });
    }
  },
};

// ============================================================================
// Rust Doc Code Block Runner Slot (#27)
// ============================================================================

import { createHash } from "node:crypto";
import * as fsSync from "node:fs";
import { countRustOutcomeAssertions, hasRustMainFunction } from "./polyglot.js";

interface RustCargoManifestMeta {
  packageName: string;
  libName: string;
  edition: string;
  libPath: string;
}

const rustWorkspaceLocks = new Map<string, Promise<void>>();
const rustWorkDirsToClean = new Set<string>();
let rustExitCleanupRegistered = false;

function registerRustWorkDirCleanup(dir: string): void {
  rustWorkDirsToClean.add(dir);
  if (rustExitCleanupRegistered) return;
  rustExitCleanupRegistered = true;
  process.once("exit", () => {
    for (const d of rustWorkDirsToClean) {
      try {
        fsSync.rmSync(d, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors on exit
      }
    }
  });
}

async function withRustWorkspaceLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = rustWorkspaceLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  rustWorkspaceLocks.set(
    key,
    prev.then(() => next),
  );
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

async function resolveCargoBinary(): Promise<string> {
  const preferred = "/root/.cargo/bin/cargo";
  try {
    await fs.access(preferred);
    return preferred;
  } catch {
    return "cargo";
  }
}

async function parseRustCargoManifest(rootDir: string): Promise<RustCargoManifestMeta> {
  let packageName = "rust_crate";
  let libName: string | undefined;
  let edition = "2021";
  let libPath = "src/lib.rs";

  try {
    const raw = await fs.readFile(path.join(rootDir, "Cargo.toml"), "utf8");
    let currentSection = "";
    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.replace(/#.*$/, "").trim();
      if (!line) continue;
      const secMatch = /^\[([^\]]+)\]$/.exec(line);
      if (secMatch) {
        currentSection = secMatch[1]!.trim();
        continue;
      }
      const kvMatch = /^([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"/.exec(line);
      if (!kvMatch) continue;
      const [, key, val] = kvMatch;
      if (currentSection === "package") {
        if (key === "name" && val) packageName = val;
        if (key === "edition" && val) edition = val;
      } else if (currentSection === "lib") {
        if (key === "name" && val) libName = val;
        if (key === "path" && val) libPath = val;
      }
    }
  } catch {
    // Fallback defaults when Cargo.toml is absent
  }

  const resolvedLibName = (libName ?? packageName).replace(/[^A-Za-z0-9_]/g, "_");
  return {
    packageName,
    libName: resolvedLibName,
    edition,
    libPath,
  };
}

function wrapRustDocCodeBlock(
  rawCode: string,
  libName: string,
  pubModules: string[],
): string {
  // Un-hide rustdoc `# ` setup lines while preserving `#[...]` and `#![...]` attributes
  const unhiddenLines = rawCode.split(/\r?\n/).map((line) => {
    const m = /^(\s*)#(?:\s+(.*)|$)/.exec(line);
    if (m) {
      return `${m[1] ?? ""}${m[2] ?? ""}`;
    }
    return line;
  });

  const innerAttrs: string[] = [];
  const bodyLines: string[] = [];
  for (const line of unhiddenLines) {
    if (/^\s*#!\[/.test(line)) {
      innerAttrs.push(line);
    } else {
      bodyLines.push(line);
    }
  }

  const bodyCode = bodyLines.join("\n");
  const modImports = pubModules.map(
    (modName) => `#[allow(unused_imports)]\nuse ${libName}::${modName}::*;`,
  );

  const prelude = [
    "#![allow(unused_imports, dead_code, unused_variables, unused_mut, unused_must_use)]",
    ...innerAttrs,
    `extern crate ${libName};`,
    `#[allow(unused_imports)]`,
    `pub use ${libName}::*;`,
    ...modImports,
  ].join("\n");

  if (hasRustMainFunction(bodyCode)) {
    return `${prelude}\n${bodyCode}\n`;
  }

  return [
    prelude,
    "fn main() {",
    "    let _ = {",
    bodyCode,
    "    };",
    "}",
    "",
  ].join("\n");
}

function summarizeRustExecutionFailure(rawOutput: string): string {
  const lines = rawOutput
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return "Rust code block execution failed with non-zero exit code.";
  }
  const priorityIdx = lines.findIndex((l) =>
    /(?:^error(?:\[E\d+\])?:|panicked at|assertion .* failed)/i.test(l),
  );
  const summary =
    priorityIdx >= 0
      ? lines.slice(priorityIdx, priorityIdx + 4).join(" | ")
      : lines.slice(0, 3).join(" | ");
  return summary.slice(0, 300);
}

export const rustDocCodeBlockRunner: DocCodeBlockRunner = {
  id: "rust",
  languages: ["rust"],
  detectOutcomeAssertions: (code) => countRustOutcomeAssertions(code),
  runCodeBlock: async (ctx) => {
    const assertionsOnOutcome = countRustOutcomeAssertions(ctx.code);
    const timeoutMs = ctx.timeoutMs ?? 20000;
    const rootAbs = path.resolve(ctx.rootDir);
    const rootHash = createHash("sha1").update(rootAbs).digest("hex").slice(0, 12);
    const workDir = path.join(os.tmpdir(), `codefog-rundocs-rust-${rootHash}`);
    registerRustWorkDirCleanup(workDir);

    return withRustWorkspaceLock(rootHash, async () => {
      try {
        const cargoBin = await resolveCargoBinary();
        const manifest = await parseRustCargoManifest(rootAbs);
        const targetDir = path.join(workDir, "target");
        const runnerDir = path.join(workDir, "runner");
        await fs.mkdir(path.join(runnerDir, "src"), { recursive: true });

        let depCratePath = rootAbs;
        const pubModules: string[] = [];
        const libAbsPath = path.join(rootAbs, manifest.libPath);

        let hasLibRs = false;
        try {
          await fs.access(libAbsPath);
          hasLibRs = true;
        } catch {
          hasLibRs = false;
        }

        if (hasLibRs) {
          try {
            const libSrc = await fs.readFile(libAbsPath, "utf8");
            const modRe = /\bpub\s+mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/g;
            let mm: RegExpExecArray | null;
            while ((mm = modRe.exec(libSrc)) !== null) {
              if (mm[1]) pubModules.push(mm[1]);
            }
          } catch {
            // ignore
          }
        } else {
          // Synthesize a library wrapper when the repo has src/*.rs without src/lib.rs
          const synthDir = path.join(workDir, "synth_lib");
          await fs.mkdir(path.join(synthDir, "src"), { recursive: true });
          const synthLibLines: string[] = [];
          try {
            const srcDir = path.join(rootAbs, "src");
            const entries = await fs.readdir(srcDir, { withFileTypes: true });
            for (const entry of entries) {
              if (
                entry.isFile() &&
                entry.name.endsWith(".rs") &&
                entry.name !== "lib.rs" &&
                entry.name !== "main.rs"
              ) {
                const stem = entry.name.replace(/\.rs$/, "");
                const fullRsPath = toPosix(path.join(srcDir, entry.name));
                synthLibLines.push(`#[path = "${fullRsPath}"]`);
                synthLibLines.push(`pub mod ${stem};`);
                synthLibLines.push(`pub use ${stem}::*;`);
                pubModules.push(stem);
              }
            }
          } catch {
            // ignore
          }
          await fs.writeFile(
            path.join(synthDir, "Cargo.toml"),
            [
              "[package]",
              `name = "${manifest.packageName}"`,
              'version = "0.1.0"',
              `edition = "${manifest.edition}"`,
              "",
              "[lib]",
              `name = "${manifest.libName}"`,
              'path = "src/lib.rs"',
            ].join("\n") + "\n",
            "utf8",
          );
          await fs.writeFile(
            path.join(synthDir, "src", "lib.rs"),
            synthLibLines.join("\n") + "\n",
            "utf8",
          );
          depCratePath = synthDir;
        }

        const runnerCargoToml =
          [
            "[package]",
            'name = "__codefog_rust_doc_runner__"',
            'version = "0.1.0"',
            `edition = "${manifest.edition}"`,
            "",
            "[dependencies]",
            `${manifest.packageName} = { path = ${JSON.stringify(toPosix(depCratePath))} }`,
          ].join("\n") + "\n";

        await fs.writeFile(path.join(runnerDir, "Cargo.toml"), runnerCargoToml, "utf8");

        const wrappedMainRs = wrapRustDocCodeBlock(
          ctx.code,
          manifest.libName,
          pubModules,
        );
        await fs.writeFile(path.join(runnerDir, "src", "main.rs"), wrappedMainRs, "utf8");

        const cargoPathDir = "/root/.cargo/bin";
        const currentPath = process.env.PATH ?? "";
        const envPath = currentPath.includes(cargoPathDir)
          ? currentPath
          : `${cargoPathDir}:${currentPath}`;

        await execFileAsync(
          cargoBin,
          ["run", "--offline", "--quiet", "--target-dir", targetDir],
          {
            cwd: runnerDir,
            timeout: timeoutMs,
            env: {
              ...process.env,
              PATH: envPath,
            },
          },
        );

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
          executionOutput: summarizeRustExecutionFailure(rawOut),
        };
      }
    });
  },
};

// ============================================================================
// Java Doc Code Block Runner Slot (#28)
// ============================================================================

import {
  countJavaOutcomeAssertions,
  findMatchingDelimiter,
  stripCommentsAndMaskStrings,
} from "./polyglot.js";

async function resolveJavaToolchain(): Promise<{ javacBin: string; javaBin: string }> {
  for (const cand of ["/usr/bin/javac", "javac"]) {
    try {
      const realJavac = await fs.realpath(cand);
      const siblingJava = path.join(path.dirname(realJavac), "java");
      try {
        await fs.access(siblingJava);
        return { javacBin: realJavac, javaBin: siblingJava };
      } catch {
        return { javacBin: realJavac, javaBin: "/usr/bin/java" };
      }
    } catch {
      // try next candidate
    }
  }
  return { javacBin: "javac", javaBin: "java" };
}

async function collectPackagesFromClassDir(
  baseDir: string,
  curDir: string,
  packages: Set<string>,
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(curDir, { withFileTypes: true });
  } catch {
    return;
  }
  let hasClassFile = false;
  for (const entry of entries) {
    const full = path.join(curDir, entry.name);
    if (entry.isDirectory()) {
      await collectPackagesFromClassDir(baseDir, full, packages);
    } else if (entry.isFile() && entry.name.endsWith(".class")) {
      hasClassFile = true;
    }
  }
  if (hasClassFile) {
    const rel = toPosix(path.relative(baseDir, curDir));
    if (rel && rel !== "." && !rel.startsWith("..")) {
      const segs = rel.split("/");
      if (segs.every((s) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s))) {
        packages.add(segs.join("."));
      }
    }
  }
}

async function discoverJavaClasspathsAndPackages(rootDir: string): Promise<{
  classpathDirs: string[];
  packages: string[];
}> {
  const classpathSet = new Set<string>();
  const directCandidates = [
    path.join(rootDir, "target", "classes"),
    path.join(rootDir, "target", "test-classes"),
    path.join(rootDir, "build", "classes", "java", "main"),
    path.join(rootDir, "build", "classes", "java", "test"),
  ];

  for (const cand of directCandidates) {
    try {
      const st = await fs.stat(cand);
      if (st.isDirectory()) {
        classpathSet.add(cand);
      }
    } catch {
      // ignore missing
    }
  }

  async function scanSubmodules(dirAbs: string, depth: number): Promise<void> {
    if (depth > 4) return;
    let entries;
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.name === ".git" ||
        entry.name === "node_modules" ||
        entry.name === ".codefog" ||
        entry.name === "dist" ||
        entry.name === "coverage" ||
        entry.name === "vendor" ||
        entry.name === ".gradle" ||
        entry.name === ".idea" ||
        entry.name === ".vscode" ||
        entry.name === "src"
      ) {
        continue;
      }
      const subDir = path.join(dirAbs, entry.name);
      for (const relCand of [
        path.join("target", "classes"),
        path.join("build", "classes", "java", "main"),
      ]) {
        const fullCand = path.join(subDir, relCand);
        try {
          const st = await fs.stat(fullCand);
          if (st.isDirectory()) {
            classpathSet.add(fullCand);
          }
        } catch {
          // ignore
        }
      }
      if (entry.name !== "target" && entry.name !== "build") {
        await scanSubmodules(subDir, depth + 1);
      }
    }
  }

  await scanSubmodules(rootDir, 0);

  const classpathDirs = Array.from(classpathSet);
  const packages = new Set<string>();
  for (const cpDir of classpathDirs) {
    await collectPackagesFromClassDir(cpDir, cpDir, packages);
  }

  return {
    classpathDirs,
    packages: Array.from(packages).sort(),
  };
}

const JAVA_DOC_ASSERTION_HELPERS = [
  "  private static void assertEquals(Object expected, Object actual) {",
  "    if (!java.util.Objects.equals(expected, actual)) {",
  '      throw new AssertionError("Expected <" + expected + "> but was <" + actual + ">");',
  "    }",
  "  }",
  "  private static void assertEquals(long expected, long actual) {",
  "    if (expected != actual) {",
  '      throw new AssertionError("Expected <" + expected + "> but was <" + actual + ">");',
  "    }",
  "  }",
  "  private static void assertEquals(double expected, double actual) {",
  "    if (Double.compare(expected, actual) != 0) {",
  '      throw new AssertionError("Expected <" + expected + "> but was <" + actual + ">");',
  "    }",
  "  }",
  "  private static void assertEquals(boolean expected, boolean actual) {",
  "    if (expected != actual) {",
  '      throw new AssertionError("Expected <" + expected + "> but was <" + actual + ">");',
  "    }",
  "  }",
  "  private static void assertNotEquals(Object unexpected, Object actual) {",
  "    if (java.util.Objects.equals(unexpected, actual)) {",
  '      throw new AssertionError("Expected not equal to <" + unexpected + ">");',
  "    }",
  "  }",
  "  private static void assertTrue(boolean condition) {",
  "    if (!condition) {",
  '      throw new AssertionError("Expected true but was false");',
  "    }",
  "  }",
  "  private static void assertFalse(boolean condition) {",
  "    if (condition) {",
  '      throw new AssertionError("Expected false but was true");',
  "    }",
  "  }",
  "  private static void assertNotNull(Object actual) {",
  "    if (actual == null) {",
  '      throw new AssertionError("Expected non-null value");',
  "    }",
  "  }",
  "  private static final class __CodefogAssertThat<T> {",
  "    private final T actual;",
  "    __CodefogAssertThat(T actual) { this.actual = actual; }",
  "    public __CodefogAssertThat<T> isEqualTo(Object expected) {",
  "      if (!java.util.Objects.equals(this.actual, expected)) {",
  '        throw new AssertionError("Expected <" + expected + "> but was <" + this.actual + ">");',
  "      }",
  "      return this;",
  "    }",
  "    public __CodefogAssertThat<T> isNotEqualTo(Object unexpected) {",
  "      if (java.util.Objects.equals(this.actual, unexpected)) {",
  '        throw new AssertionError("Expected not equal to <" + unexpected + ">");',
  "      }",
  "      return this;",
  "    }",
  "    public __CodefogAssertThat<T> isNotNull() {",
  "      if (this.actual == null) {",
  '        throw new AssertionError("Expected non-null value");',
  "      }",
  "      return this;",
  "    }",
  "    public __CodefogAssertThat<T> isTrue() {",
  "      if (!Boolean.TRUE.equals(this.actual)) {",
  '        throw new AssertionError("Expected true but was " + this.actual);',
  "      }",
  "      return this;",
  "    }",
  "    public __CodefogAssertThat<T> isFalse() {",
  "      if (!Boolean.FALSE.equals(this.actual)) {",
  '        throw new AssertionError("Expected false but was " + this.actual);',
  "      }",
  "      return this;",
  "    }",
  "  }",
  "  private static <T> __CodefogAssertThat<T> assertThat(T actual) {",
  "    return new __CodefogAssertThat<T>(actual);",
  "  }",
].join("\n");

function findTopLevelJavaClass(
  sourceText: string,
): { className: string; closeBraceIdx: number } | null {
  const { masked } = stripCommentsAndMaskStrings(sourceText);
  let depth = 0;
  const classRe =
    /\b(?:(public)\s+)?(?:(?:protected|private|abstract|final|static|strictfp)\s+)*(?:class|record|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
  const candidates: Array<{ isPublic: boolean; className: string; closeBraceIdx: number }> = [];

  let scanIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = classRe.exec(masked)) !== null) {
    while (scanIdx < m.index) {
      if (masked[scanIdx] === "{") depth++;
      else if (masked[scanIdx] === "}") depth = Math.max(0, depth - 1);
      scanIdx++;
    }
    if (depth === 0) {
      const openBraceIdx = masked.indexOf("{", m.index + m[0].length);
      if (openBraceIdx !== -1) {
        const closeBraceIdx = findMatchingDelimiter(masked, openBraceIdx, "{", "}");
        if (closeBraceIdx !== -1) {
          candidates.push({
            isPublic: Boolean(m[1]),
            className: m[2]!,
            closeBraceIdx,
          });
        }
      }
    }
  }

  if (candidates.length === 0) return null;
  return candidates.find((c) => c.isPublic) ?? candidates[0]!;
}

function prepareJavaCodeBlockSource(
  rawCode: string,
  discoveredPackages: string[],
): {
  className: string;
  qualifiedMainClass: string;
  sourceCode: string;
} {
  const lines = rawCode.split(/\r?\n/);
  let declaredPackage = "";
  const userImports: string[] = [];
  const bodyLines: string[] = [];

  for (const line of lines) {
    const pkgMatch = /^\s*package\s+([A-Za-z_$][A-Za-z0-9_$.]*)\s*;\s*(?:\/\/.*)?$/.exec(line);
    if (pkgMatch && !declaredPackage && bodyLines.every((l) => l.trim() === "")) {
      declaredPackage = pkgMatch[1]!;
      continue;
    }
    const impMatch = /^\s*import\s+(?:static\s+)?([A-Za-z_$][A-Za-z0-9_$.*]*)\s*;\s*(?:\/\/.*)?$/.exec(
      line,
    );
    if (impMatch) {
      const impSpec = impMatch[1]!;
      if (impSpec.startsWith("org.junit.") || impSpec.startsWith("org.assertj.")) {
        continue;
      }
      userImports.push(line.trim());
      continue;
    }
    bodyLines.push(line);
  }

  const bodyText = bodyLines.join("\n");
  const autoImports: string[] = ["import java.util.*;"];
  for (const pkg of discoveredPackages) {
    if (pkg !== declaredPackage) {
      const wildcard = `import ${pkg}.*;`;
      if (!userImports.includes(wildcard)) {
        autoImports.push(wildcard);
      }
    }
  }

  const pkgHeader = declaredPackage ? `package ${declaredPackage};\n` : "";
  const importHeader = [...autoImports, ...userImports].join("\n");

  const topClass = findTopLevelJavaClass(bodyText);
  if (topClass) {
    const className = topClass.className;
    const qualifiedMainClass = declaredPackage
      ? `${declaredPackage}.${className}`
      : className;
    const injectedBody =
      bodyText.slice(0, topClass.closeBraceIdx) +
      "\n" +
      JAVA_DOC_ASSERTION_HELPERS +
      "\n" +
      bodyText.slice(topClass.closeBraceIdx);
    return {
      className,
      qualifiedMainClass,
      sourceCode: [pkgHeader, importHeader, injectedBody].filter(Boolean).join("\n\n") + "\n",
    };
  }

  const className = "CodefogDocSnippet";
  const qualifiedMainClass = declaredPackage
    ? `${declaredPackage}.${className}`
    : className;
  const { masked: bodyMasked } = stripCommentsAndMaskStrings(bodyText);
  const hasMainMethod = /\bstatic\s+void\s+main\s*\(/.test(bodyMasked);

  const wrappedClassBody = hasMainMethod
    ? [
        `public class ${className} {`,
        bodyText,
        JAVA_DOC_ASSERTION_HELPERS,
        "}",
      ].join("\n")
    : [
        `public class ${className} {`,
        "  public static void main(String[] args) throws Throwable {",
        bodyText,
        "  }",
        JAVA_DOC_ASSERTION_HELPERS,
        "}",
      ].join("\n");

  return {
    className,
    qualifiedMainClass,
    sourceCode: [pkgHeader, importHeader, wrappedClassBody].filter(Boolean).join("\n\n") + "\n",
  };
}

function summarizeJavaExecutionFailure(rawOutput: string): string {
  const lines = rawOutput
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => Boolean(l) && !/^\^+$/.test(l));
  if (lines.length === 0) {
    return "Java code block execution failed with non-zero exit code.";
  }
  const priorityIdx = lines.findIndex((l) =>
    /(?:error:|AssertionError|Exception|Error)/i.test(l),
  );
  const slice =
    priorityIdx >= 0
      ? lines.slice(priorityIdx, priorityIdx + 4)
      : lines.slice(0, 4);
  return slice.join(" | ").slice(0, 300);
}

export const javaDocCodeBlockRunner: DocCodeBlockRunner = {
  id: "java",
  languages: ["java"],
  detectOutcomeAssertions: (code) => countJavaOutcomeAssertions(code),
  runCodeBlock: async (ctx) => {
    const assertionsOnOutcome = countJavaOutcomeAssertions(ctx.code);
    const timeoutMs = ctx.timeoutMs ?? 15000;
    const execDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefog-rundocs-java-"));

    try {
      const [{ javacBin, javaBin }, { classpathDirs, packages }] = await Promise.all([
        resolveJavaToolchain(),
        discoverJavaClasspathsAndPackages(ctx.rootDir),
      ]);

      const prepared = prepareJavaCodeBlockSource(ctx.code, packages);
      const javaFilePath = path.join(execDir, `${prepared.className}.java`);
      await fs.writeFile(javaFilePath, prepared.sourceCode, "utf8");

      const classpath = [execDir, ...classpathDirs].join(path.delimiter);

      await execFileAsync(
        javacBin,
        ["-cp", classpath, "-d", execDir, javaFilePath],
        {
          cwd: ctx.rootDir,
          timeout: timeoutMs,
        },
      );

      await execFileAsync(
        javaBin,
        ["-ea", "-cp", classpath, prepared.qualifiedMainClass],
        {
          cwd: ctx.rootDir,
          timeout: timeoutMs,
        },
      );

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
        executionOutput: summarizeJavaExecutionFailure(rawOut),
      };
    } finally {
      await fs.rm(execDir, { recursive: true, force: true });
    }
  },
};

// ============================================================================
// Runner Registry & Dispatcher
// ============================================================================

export const DOC_CODE_BLOCK_RUNNERS: DocCodeBlockRunner[] = [
  tsJsDocCodeBlockRunner,
  goDocCodeBlockRunner,
  rustDocCodeBlockRunner,
  javaDocCodeBlockRunner,
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
