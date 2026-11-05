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
  cargoTargetDir?: string;
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

function instrumentCodeBlockForExecution(rawCode: string): string {
  const sf = ts.createSourceFile(
    "block.ts",
    rawCode,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );

  const nonTypeImportedLocalNames: string[] = [];

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && stmt.importClause) {
      const isTypeOnlyClause = stmt.importClause.isTypeOnly;
      if (stmt.importClause.name && !isTypeOnlyClause) {
        nonTypeImportedLocalNames.push(stmt.importClause.name.text);
      }
      const nb = stmt.importClause.namedBindings;
      if (nb) {
        if (ts.isNamespaceImport(nb) && !isTypeOnlyClause) {
          nonTypeImportedLocalNames.push(nb.name.text);
        } else if (ts.isNamedImports(nb)) {
          for (const el of nb.elements) {
            if (!isTypeOnlyClause && !el.isTypeOnly) {
              nonTypeImportedLocalNames.push(el.name.text);
            }
          }
        }
      }
    }
  }

  // Reference non-type imported bindings so TypeScript transpileModule does not elide them
  const keepImportsLine =
    nonTypeImportedLocalNames.length > 0
      ? `\nvoid [${nonTypeImportedLocalNames.join(", ")}];`
      : "";

  return [rawCode, keepImportsLine].filter(Boolean).join("\n");
}

function summarizeRunnerOutput(
  rawOutput: string,
  options: {
    priorityPattern: RegExp;
    ignoreLine?: (line: string) => boolean;
    defaultMessage: string;
    maxLines?: number;
  },
): string {
  const lines = rawOutput
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => Boolean(l) && (!options.ignoreLine || !options.ignoreLine(l)));
  if (lines.length === 0) {
    return options.defaultMessage;
  }
  const count = options.maxLines ?? 3;
  const priorityIdx = lines.findIndex((l) => options.priorityPattern.test(l));
  const slice =
    priorityIdx >= 0
      ? lines.slice(priorityIdx, priorityIdx + count)
      : lines.slice(0, count);
  return slice.join(" | ").slice(0, 300);
}

function buildRunnerFailureResult(
  err: unknown,
  params: {
    assertionsOnOutcome: number;
    timeoutMs: number;
    priorityPattern: RegExp;
    ignoreLine?: (line: string) => boolean;
    defaultMessage: string;
    maxLines?: number;
  },
): DocCodeBlockRunResult {
  const e = err as {
    stderr?: unknown;
    stdout?: unknown;
    message?: unknown;
    killed?: unknown;
    signal?: unknown;
  };
  const stderr = typeof e?.stderr === "string" ? e.stderr : "";
  const stdout = typeof e?.stdout === "string" ? e.stdout : "";
  const message = typeof e?.message === "string" ? e.message : String(err);
  const killed = Boolean(e?.killed) || e?.signal === "SIGTERM";
  const rawOut = killed
    ? `Execution timed out after ${params.timeoutMs}ms. ${stderr || stdout || message}`
    : stderr || stdout || message;
  return {
    passed: false,
    assertionsOnOutcome: params.assertionsOnOutcome,
    executionOutput: summarizeRunnerOutput(rawOut, params),
  };
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

      const selfPkgNames = new Set<string>();
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

      for (const rel of sourceFiles) {
        const srcText = await fs.readFile(path.join(ctx.rootDir, rel), "utf8");
        const stem = stripTsJsExt(rel);

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

      // Build __pkg_entry__.js re-exporting ONLY the primary package entry module
      const entryLines: string[] = [];
      const primaryEntryStems = ["src/index", "index"];
      const primaryStem = primaryEntryStems.find((s) => knownStems.has(s));
      if (primaryStem) {
        entryLines.push(`export * from "./${primaryStem}.js";`);
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
      const instrumentedCode = instrumentCodeBlockForExecution(ctx.code);
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
    } catch (err) {
      return buildRunnerFailureResult(err, {
        assertionsOnOutcome,
        timeoutMs,
        priorityPattern:
          /(?:AssertionError|SyntaxError|ReferenceError|TypeError|Error:|ERR_|does not provide an export|Cannot find module)/i,
        defaultMessage: "Code block execution failed with non-zero exit code.",
      });
    } finally {
      await fs.rm(execDir, { recursive: true, force: true });
    }
  },
};

// ============================================================================
// Go Doc Code Block Runner Slot (#26)
// ============================================================================

import * as fsSync from "node:fs";
import {
  countGoOutcomeAssertions,
  findFilesByExtensionInRepo,
} from "./polyglot.js";

async function findExecutableInDirs(
  binName: string,
  dirs: string[],
): Promise<string | null> {
  const exeName =
    process.platform === "win32" && !binName.endsWith(".exe")
      ? `${binName}.exe`
      : binName;
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, exeName);
    try {
      await fs.access(candidate, fsSync.constants.X_OK);
      return candidate;
    } catch {
      // try next directory
    }
  }
  return null;
}

function getPathDirs(): string[] {
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .map((d) => d.trim())
    .filter(Boolean);
}

function wrapGoDocCodeBlock(rawCode: string): string {
  const { noComments, masked } = stripCommentsAndMaskStrings(rawCode);

  const spansToRemove: Array<{ start: number; end: number }> = [];
  const explicitImports: string[] = [];

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
      explicitImports.push(alias ? `${alias} "${impPath}"` : `"${impPath}"`);
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
    explicitImports.push(alias ? `${alias} "${impPath}"` : `"${impPath}"`);
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

  const { masked: bodyMasked } = stripCommentsAndMaskStrings(remainingBody);

  // 4. Check if `func main(` already exists; if not, separate any top-level named funcs and wrap statements in `func main()`
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

  const dedupedImports = Array.from(new Set(explicitImports));
  const importSection =
    dedupedImports.length > 0
      ? `import (\n${dedupedImports.map((s) => `\t${s}`).join("\n")}\n)\n\n`
      : "";

  return `package main\n\n${importSection}${assembledMainSection}\n`;
}

async function resolveGoBinary(): Promise<string> {
  const dirs: string[] = [];
  if (process.env.GOROOT) {
    dirs.push(path.join(process.env.GOROOT, "bin"));
  }
  dirs.push(...getPathDirs());
  return (await findExecutableInDirs("go", dirs)) ?? "go";
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

      for (const rel of prodGoFiles) {
        const srcText = await fs.readFile(path.join(ctx.rootDir, rel), "utf8");
        const destPath = path.join(execDir, rel);
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        await fs.writeFile(destPath, srcText, "utf8");
      }

      const runnerDir = path.join(execDir, "codefog_doc_runner");
      await fs.mkdir(runnerDir, { recursive: true });

      const wrappedGoCode = wrapGoDocCodeBlock(ctx.code);
      await fs.writeFile(path.join(runnerDir, "main.go"), wrappedGoCode, "utf8");

      const goBin = await resolveGoBinary();
      const goBinDir = path.isAbsolute(goBin) ? path.dirname(goBin) : "";
      const currentPath = process.env.PATH ?? "";
      const envPath =
        goBinDir && !currentPath.split(path.delimiter).includes(goBinDir)
          ? `${goBinDir}${path.delimiter}${currentPath}`
          : currentPath;

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
    } catch (err) {
      return buildRunnerFailureResult(err, {
        assertionsOnOutcome,
        timeoutMs,
        priorityPattern:
          /(?:undefined:|cannot use|not enough arguments|too many arguments|syntax error:|panic:|fatal error:|no required module|imported and not used)/i,
        ignoreLine: (l) => l.startsWith("# "),
        defaultMessage: "Go code block execution failed with non-zero exit code.",
      });
    } finally {
      await fs.rm(execDir, { recursive: true, force: true });
    }
  },
};

// ============================================================================
// Rust Doc Code Block Runner Slot (#27)
// ============================================================================

import { countRustOutcomeAssertions, hasRustMainFunction } from "./polyglot.js";

interface RustCargoManifestMeta {
  packageName: string;
  libName: string;
  edition: string;
  libPath: string;
}

const rustWorkspaceLocks = new Map<string, Promise<void>>();

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
  const dirs: string[] = [];
  if (process.env.CARGO_HOME) {
    dirs.push(path.join(process.env.CARGO_HOME, "bin"));
  }
  dirs.push(...getPathDirs());
  dirs.push(path.join(os.homedir(), ".cargo", "bin"));
  return (await findExecutableInDirs("cargo", dirs)) ?? "cargo";
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

function wrapRustDocCodeBlock(rawCode: string, libName: string): string {
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
  const prelude = [
    "#![allow(unused_imports, dead_code, unused_variables, unused_mut, unused_must_use)]",
    ...innerAttrs,
    `extern crate ${libName};`,
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

export const rustDocCodeBlockRunner: DocCodeBlockRunner = {
  id: "rust",
  languages: ["rust"],
  detectOutcomeAssertions: (code) => countRustOutcomeAssertions(code),
  runCodeBlock: async (ctx) => {
    const assertionsOnOutcome = countRustOutcomeAssertions(ctx.code);
    const timeoutMs = ctx.timeoutMs ?? 20000;
    const rootAbs = path.resolve(ctx.rootDir);
    const execDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefog-rundocs-rust-"));
    const targetDir = ctx.cargoTargetDir ?? path.join(execDir, "target");

    try {
      return await withRustWorkspaceLock(targetDir, async () => {
        try {
          const cargoBin = await resolveCargoBinary();
          const manifest = await parseRustCargoManifest(rootAbs);
          const runnerDir = path.join(execDir, "runner");
          await fs.mkdir(path.join(runnerDir, "src"), { recursive: true });

          const runnerCargoToml =
            [
              "[package]",
              'name = "__codefog_rust_doc_runner__"',
              'version = "0.1.0"',
              `edition = "${manifest.edition}"`,
              "",
              "[dependencies]",
              `${manifest.packageName} = { path = ${JSON.stringify(toPosix(rootAbs))} }`,
            ].join("\n") + "\n";

          await fs.writeFile(path.join(runnerDir, "Cargo.toml"), runnerCargoToml, "utf8");

          const wrappedMainRs = wrapRustDocCodeBlock(ctx.code, manifest.libName);
          await fs.writeFile(path.join(runnerDir, "src", "main.rs"), wrappedMainRs, "utf8");

          const cargoBinDir = path.isAbsolute(cargoBin) ? path.dirname(cargoBin) : "";
          const currentPath = process.env.PATH ?? "";
          const envPath =
            cargoBinDir && !currentPath.split(path.delimiter).includes(cargoBinDir)
              ? `${cargoBinDir}${path.delimiter}${currentPath}`
              : currentPath;

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
        } catch (err) {
          return buildRunnerFailureResult(err, {
            assertionsOnOutcome,
            timeoutMs,
            priorityPattern: /(?:^error(?:\[E\d+\])?:|panicked at|assertion .* failed)/i,
            defaultMessage: "Rust code block execution failed with non-zero exit code.",
            maxLines: 4,
          });
        }
      });
    } finally {
      await fs.rm(execDir, { recursive: true, force: true });
    }
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
  const pathDirs = getPathDirs();
  const javaHomeDirs = process.env.JAVA_HOME
    ? [path.join(process.env.JAVA_HOME, "bin")]
    : [];

  const foundJavac =
    (await findExecutableInDirs("javac", [...javaHomeDirs, ...pathDirs])) ?? "javac";
  let realJavac = foundJavac;
  try {
    realJavac = await fs.realpath(foundJavac);
  } catch {
    // keep foundJavac
  }

  // Prefer $JAVA_HOME/bin/java, else java next to realpath(javac), else PATH java
  const fromJavaHome =
    javaHomeDirs.length > 0 ? await findExecutableInDirs("java", javaHomeDirs) : null;
  if (fromJavaHome) {
    return { javacBin: realJavac, javaBin: fromJavaHome };
  }

  if (path.isAbsolute(realJavac)) {
    const siblingJava = await findExecutableInDirs("java", [path.dirname(realJavac)]);
    if (siblingJava) {
      return { javacBin: realJavac, javaBin: siblingJava };
    }
  }

  const fromPath = (await findExecutableInDirs("java", pathDirs)) ?? "java";
  return { javacBin: realJavac, javaBin: fromPath };
}

async function discoverJavaClasspaths(rootDir: string): Promise<string[]> {
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
  return Array.from(classpathSet);
}

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

function prepareJavaCodeBlockSource(rawCode: string): {
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
      userImports.push(line.trim());
      continue;
    }
    bodyLines.push(line);
  }

  const bodyText = bodyLines.join("\n");
  const pkgHeader = declaredPackage ? `package ${declaredPackage};\n` : "";
  const importHeader = userImports.join("\n");

  const topClass = findTopLevelJavaClass(bodyText);
  if (topClass) {
    const className = topClass.className;
    const qualifiedMainClass = declaredPackage
      ? `${declaredPackage}.${className}`
      : className;
    return {
      className,
      qualifiedMainClass,
      sourceCode: [pkgHeader, importHeader, bodyText].filter(Boolean).join("\n\n") + "\n",
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
        "}",
      ].join("\n")
    : [
        `public class ${className} {`,
        "  public static void main(String[] args) throws Throwable {",
        bodyText,
        "  }",
        "}",
      ].join("\n");

  return {
    className,
    qualifiedMainClass,
    sourceCode: [pkgHeader, importHeader, wrappedClassBody].filter(Boolean).join("\n\n") + "\n",
  };
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
      const [{ javacBin, javaBin }, classpathDirs] = await Promise.all([
        resolveJavaToolchain(),
        discoverJavaClasspaths(ctx.rootDir),
      ]);

      const prepared = prepareJavaCodeBlockSource(ctx.code);
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
    } catch (err) {
      return buildRunnerFailureResult(err, {
        assertionsOnOutcome,
        timeoutMs,
        priorityPattern: /(?:error:|AssertionError|Exception|Error)/i,
        ignoreLine: (l) => /^\^+$/.test(l),
        defaultMessage: "Java code block execution failed with non-zero exit code.",
        maxLines: 4,
      });
    } finally {
      await fs.rm(execDir, { recursive: true, force: true });
    }
  },
};

// ============================================================================
// Runner Registry & Dispatcher
// ============================================================================

export const DOC_CODE_BLOCK_RUNNERS: readonly DocCodeBlockRunner[] = [
  tsJsDocCodeBlockRunner,
  goDocCodeBlockRunner,
  rustDocCodeBlockRunner,
  javaDocCodeBlockRunner,
];

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
  cargoTargetDir?: string;
}): Promise<DocClaim | null> {
  const { rootDir, docFile, block, runDocs, symbolIndex, pkgInfo, cargoTargetDir } = params;
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
  const referentText = `${lang}:${block.startLine}-${block.endLine}`;
  const text = `${lang} code block (${docFile}:${block.startLine}-${block.endLine})`;

  if (!runDocs) {
    return {
      id: claimId,
      file: docFile,
      kind: "code-block",
      text,
      rawText: block.rawText,
      referentText,
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
    ...(cargoTargetDir ? { cargoTargetDir } : {}),
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
    referentText,
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
