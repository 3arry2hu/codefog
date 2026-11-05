import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { analyzeRepository } from "./analyzer.js";
import { analyzeDocClaims } from "./doc-claims.js";
import { computeDiffComparison, writePrCommentArtifacts } from "./diff-pr.js";
import { writeHtmlFogMap } from "./html-report.js";
import { installCodefogSkill } from "./skill-installer.js";
import { verifyTargetWithMutants } from "./verify.js";
import type { CodefogReport } from "./types.js";

const execFileAsync = promisify(execFile);

export const MIN_SUPPORTED_NPM_MAJOR = 9;

export function detectOutdatedNpmVersion(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const rawVersion =
    env.CODEFOG_NPM_VERSION?.trim() ||
    /\bnpm\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(env.npm_config_user_agent ?? "")?.[1];
  if (!rawVersion) return null;
  const major = Number.parseInt(rawVersion.split(".")[0] ?? "", 10);
  if (Number.isFinite(major) && major < MIN_SUPPORTED_NPM_MAJOR) {
    return rawVersion;
  }
  return null;
}

async function resolveOutdatedNpmVersion(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const fromEnv = detectOutdatedNpmVersion(env);
  if (fromEnv) return fromEnv;
  if (env.npm_config_user_agent || env.CODEFOG_NPM_VERSION || env.VITEST) {
    return null;
  }
  try {
    const { stdout } = await execFileAsync("npm", ["--version"], { timeout: 1500 });
    const ver = stdout.trim();
    const major = Number.parseInt(ver.split(".")[0] ?? "", 10);
    if (Number.isFinite(major) && major < MIN_SUPPORTED_NPM_MAJOR) {
      return ver;
    }
  } catch {
    // ignore if npm is not in PATH
  }
  return null;
}

export function formatOutdatedNpmWarning(version: string): string {
  return [
    `[codefog] Warning: Detected outdated npm/npx v${version} (< ${MIN_SUPPORTED_NPM_MAJOR}.0.0).`,
    `检测到当前使用的 npm/npx 版本较旧 (v${version} < ${MIN_SUPPORTED_NPM_MAJOR}.0.0)：旧版 npx (如 8.x) 会吞掉 --coverage 等命令行参数，且存在 @latest 缓存不更新问题。`,
    `请升级 npm/npx 至最新版本 (>= ${MIN_SUPPORTED_NPM_MAJOR}.0.0)：`,
    `  npm install -g npm@latest`,
    `（若暂时无法升级，请在包名后加上 '--' 传递参数：npx @barryzhu/codefog@latest -- --coverage coverage.out）`,
    "",
  ].join("\n");
}

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

function openInDefaultBrowser(filePath: string): void {
  const opener =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", filePath] : [filePath];
  try {
    const child = execFile(opener, args);
    child.unref();
  } catch {
    // Best-effort browser open in headless/CI environments
  }
}

export function formatLevel1Summary(report: CodefogReport): string {
  const { summary, repository, modules, findings } = report;
  const unverifiedLoc = summary.totalLoc - summary.locByState.verified;
  const fogPct =
    summary.totalLoc > 0 ? Math.round((unverifiedLoc / summary.totalLoc) * 100) : 0;

  const docTrustPart =
    summary.docTrustScore !== undefined
      ? ` | Doc Trust Score: ${summary.docTrustScore}/100`
      : "";

  const lines: string[] = [
    `codefog | ${repository.name} (${repository.branch} @ ${repository.commit})`,
    `Trust Score: ${summary.trustScore}/100${docTrustPart} | Files: ${summary.totalFiles} | LOC: ${summary.totalLoc} | Unverified (Fog): ${fogPct}%`,
    `Metrics: Line ${summary.metrics.lineCoveragePct}% | Branch ${summary.metrics.branchCoveragePct}% | Checked ${summary.metrics.checkedCoveragePct}% | Mutation ${summary.metrics.mutationScorePct}% | Pseudo-tested: ${summary.metrics.pseudoTestedMethods} | Contested: ${summary.metrics.contestedOracles}`,
    `States: Returned=${summary.locByState["fog-returned"]} Fog=${summary.locByState.fog} Self-proof=${summary.locByState["self-proof-fog"]} Weak=${summary.locByState["weak-evidence"]} Verified=${summary.locByState.verified}`,
    ...(summary.docClaimsByState
      ? [
          `Doc Claims (${summary.totalDocClaims ?? 0}): Returned=${summary.docClaimsByState["fog-returned"]} Fog=${summary.docClaimsByState.fog} Weak=${summary.docClaimsByState["weak-evidence"]} Verified=${summary.docClaimsByState.verified}`,
        ]
      : []),
    "",
    "Modules by Fog:",
  ];

  for (const mod of modules) {
    lines.push(
      `  - ${mod.path}: Trust ${mod.trustScore}/100 | Risk ${mod.maxRiskScore} | Fog=${mod.locByState.fog} Weak=${mod.locByState["weak-evidence"]} Verified=${mod.locByState.verified}`,
    );
  }

  if (findings.length > 0) {
    lines.push("", "Top Fog Hotspots & Findings:");
    for (const f of findings.slice(0, 5)) {
      lines.push(
        `  - [${f.id}] ${f.location.file}:${f.location.startLine}-${f.location.endLine} (${f.title}) | ${f.state} | risk ${f.riskScore}`,
      );
    }
  }

  return lines.join("\n") + "\n";
}

export async function runCli(
  rawArgv: string[],
  io: CliIo = {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  },
): Promise<number> {
  try {
    const outdatedNpm = await resolveOutdatedNpmVersion(process.env);
    if (outdatedNpm) {
      io.stderr(formatOutdatedNpmWarning(outdatedNpm));
    }

    const argv: string[] = [];
    for (const token of rawArgv) {
      if (token.startsWith("--") && token.includes("=")) {
        const eqIdx = token.indexOf("=");
        argv.push(token.slice(0, eqIdx), token.slice(eqIdx + 1));
      } else {
        argv.push(token);
      }
    }

    if (argv.includes("--version") || argv.includes("-v")) {
      io.stdout("1.4.0\n");
      return 0;
    }
    if (argv.includes("--help") || argv.includes("-h")) {
      io.stdout(
        [
          "codefog - Fog-first trust and risk map for TypeScript/JavaScript, Go, Rust, and Java repositories",
          "",
          "Usage:",
          "  codefog [rootDir] [options]",
          "  codefog verify <targetFile> [--lines start-end] [--mutants] [--oracle] [--test-cmd <cmd>]",
          "  codefog install-skill [--agent <codex|claude-code|codebuddy|cursor|all>] [--global|-g]",
          "",
          "Options:",
          "  --coverage <path>     Path(s) to coverage file(s) (LCOV, Go coverprofile, JaCoCo XML; comma-separated or repeatable)",
          "  --lcov <path>         Alias for --coverage (default: auto-detects coverage/lcov.info, coverage.out, etc.)",
          "  --mutation-report <p> Path to mutation report (Stryker JSON, PITest XML, cargo-mutants JSON)",
          "  --stryker <path>      Alias for --mutation-report",
          "  --expectations <path> Independent expectation manifest (default: oracles/expectations.json when present)",
          "  --defects <path>      Historical defect manifest (default: oracles/defects.json when present)",
          "  --docs                Scan Markdown & AI instruction files for Doc Claims and compute Doc Trust Score",
          "  --check-external-links Check external HTTP(S) links when --docs is enabled",
          "  --run-docs            Execute runnable code blocks in Markdown when --docs is enabled",
          "  --sarif <path>        Import SARIF 2.1.0 report(s) as external overlay (repeatable)",
          "  --knip <path>         Import Knip JSON report(s) as external overlay (repeatable)",
          "  --libyear <path>      Import libyear JSON report(s) as repository dependency overlay (repeatable)",
          "  --diff <baseRef>      Compare against base git ref (e.g. origin/main)",
          "  --html <path>         Output path for interactive HTML Fog Map (default: .codefog/report.html)",
          "  --pr-comment [dir]    Write PR comment Markdown and SVG artifacts",
          "  --json                Output full JSON report to stdout",
          "  --open                Open HTML Fog Map in default browser",
          "  --fail-on <policy>    Exit gate policy: returned | doc-returned | regression | any-fog | contested | none (default: returned)",
          "  --install-skill [ag]  Install AI agent skill for codex, claude-code, codebuddy, cursor (default: all)",
          "  -g, --global          Install AI skill into user home directory (~/.cursor/skills, ~/.claude/skills, etc.)",
          "  -v, --version         Print version",
          "  -h, --help            Print help",
          "",
        ].join("\n"),
      );
      return 0;
    }

    const isInstallSkillCmd =
      argv[0] === "install-skill" ||
      argv[0] === "skill" ||
      argv[0] === "init-skill" ||
      argv.includes("--install-skill") ||
      (process.env.npm_command === "exec" && Boolean(process.env.npm_config_install_skill));

    if (isInstallSkillCmd) {
      let rootDir = process.cwd();
      let isGlobal = false;
      const agentSpecs: string[] = [];

      if (process.env.npm_command === "exec") {
        if (process.env.npm_config_global === "true") isGlobal = true;
        const envAgent = process.env.npm_config_agent || process.env.npm_config_target;
        if (envAgent && envAgent !== "true" && envAgent !== "false") {
          agentSpecs.push(envAgent);
        }
        const envInstallSkill = process.env.npm_config_install_skill;
        if (envInstallSkill && envInstallSkill !== "true" && envInstallSkill !== "false") {
          agentSpecs.push(envInstallSkill);
        }
      }

      for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        if (arg === "install-skill" || arg === "skill" || arg === "init-skill") {
          continue;
        }
        if (arg === "--install-skill") {
          const next = argv[i + 1];
          if (next && !next.startsWith("-")) {
            agentSpecs.push(argv[++i]!);
          }
        } else if (arg === "--agent" || arg === "--agents" || arg === "--target") {
          const next = argv[++i];
          if (next) agentSpecs.push(next);
        } else if (arg === "--global" || arg === "-g") {
          isGlobal = true;
        } else if (arg === "--root") {
          rootDir = path.resolve(argv[++i] ?? ".");
        } else if (!arg.startsWith("-")) {
          agentSpecs.push(arg);
        }
      }

      const res = await installCodefogSkill({
        rootDir,
        agents: agentSpecs.length > 0 ? agentSpecs : undefined,
        global: isGlobal,
      });
      io.stdout(res.summary + "\n");
      return 0;
    }
    if (argv[0] === "verify") {
      let rootDir = process.cwd();
      let targetFile = "";
      let mutants = false;
      let startLine: number | undefined;
      let endLine: number | undefined;
      let testCmd: string | undefined;
      let allowSourceChange = false;
      let oracle = false;
      let expectationsPath: string | undefined;
      let defectsPath: string | undefined;
      let runDocs = false;
      let checkExternalLinks = false;

      if (process.env.npm_command === "exec") {
        if (process.env.npm_config_mutants === "true") mutants = true;
        if (process.env.npm_config_oracle === "true") oracle = true;
        if (process.env.npm_config_allow_source_change === "true") allowSourceChange = true;
        if (process.env.npm_config_run_docs === "true") runDocs = true;
        if (process.env.npm_config_check_external_links === "true") checkExternalLinks = true;
        const envExpectations = process.env.npm_config_expectations;
        if (envExpectations && envExpectations !== "true" && envExpectations !== "false") {
          expectationsPath = envExpectations;
        }
        const envDefects = process.env.npm_config_defects;
        if (envDefects && envDefects !== "true" && envDefects !== "false") {
          defectsPath = envDefects;
        }
        const envLines = process.env.npm_config_lines;
        if (envLines && envLines !== "true" && envLines !== "false") {
          const [s, e] = envLines.split("-").map((n) => parseInt(n, 10));
          if (!Number.isNaN(s)) startLine = s;
          if (!Number.isNaN(e)) endLine = e;
          else if (startLine !== undefined) endLine = startLine;
        }
        const envTestCmd = process.env.npm_config_test_cmd;
        if (envTestCmd && envTestCmd !== "true" && envTestCmd !== "false") {
          testCmd = envTestCmd;
        }
      }

      for (let i = 1; i < argv.length; i++) {
        const arg = argv[i]!;
        if (arg === "--mutants") {
          mutants = true;
        } else if (arg === "--oracle") {
          oracle = true;
        } else if (arg === "--expectations") {
          expectationsPath = argv[++i];
        } else if (arg === "--defects") {
          defectsPath = argv[++i];
        } else if (arg === "--allow-source-change") {
          allowSourceChange = true;
        } else if (arg === "--run-docs") {
          runDocs = true;
        } else if (arg === "--check-external-links") {
          checkExternalLinks = true;
        } else if (arg === "--root") {
          rootDir = path.resolve(argv[++i] ?? ".");
        } else if (arg === "--lines") {
          const range = argv[++i] ?? "";
          const [s, e] = range.split("-").map((n) => parseInt(n, 10));
          if (!Number.isNaN(s)) startLine = s;
          if (!Number.isNaN(e)) endLine = e;
          else if (startLine !== undefined) endLine = startLine;
        } else if (arg === "--test-cmd") {
          testCmd = argv[++i];
        } else if (!arg.startsWith("-")) {
          if (!targetFile) {
            targetFile = arg;
          } else if (/^\d+(?:-\d+)?$/.test(arg) && startLine === undefined) {
            const [s, e] = arg.split("-").map((n) => parseInt(n, 10));
            if (!Number.isNaN(s)) startLine = s;
            if (!Number.isNaN(e)) endLine = e;
            else if (startLine !== undefined) endLine = startLine;
          } else if (!testCmd) {
            testCmd = arg;
          }
        }
      }

      if (!targetFile) {
        io.stderr("Error: codefog verify requires a <target> file path.\n");
        return 1;
      }

      const verifyRes = await verifyTargetWithMutants({
        rootDir,
        targetFile,
        mutants,
        startLine,
        endLine,
        testCmd,
        allowSourceChange,
        oracle,
        expectationsPath,
        defectsPath,
        runDocs,
        checkExternalLinks,
      });

      if (verifyRes.passed) {
        io.stdout(verifyRes.summary + "\n");
      } else {
        io.stderr(verifyRes.summary + "\n");
      }
      return verifyRes.exitCode;
    }

    let rootDir = process.cwd();
    let lcovPath: string | undefined;
    const coveragePaths: string[] = [];
    let strykerPath: string | undefined;
    let mutationReportPath: string | undefined;
    let diffBase: string | undefined;
    let htmlPath: string | undefined;
    let prCommentDir: string | undefined;
    let jsonMode = false;
    let openBrowser = false;
    let failOn = "returned";
    let expectationsPath: string | undefined;
    let defectsPath: string | undefined;
    let docsMode = false;
    let checkExternalLinks = false;
    let runDocs = false;
    const sarifPaths: string[] = [];
    const knipPaths: string[] = [];
    const libyearPaths: string[] = [];
    const externalReportPaths: string[] = [];

    const positional: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i]!;
      if (arg === "--json") {
        jsonMode = true;
      } else if (arg === "--docs") {
        docsMode = true;
      } else if (arg === "--check-external-links") {
        checkExternalLinks = true;
      } else if (arg === "--run-docs") {
        runDocs = true;
      } else if (arg === "--root") {
        rootDir = path.resolve(argv[++i] ?? ".");
      } else if (arg === "--coverage") {
        const val = argv[++i];
        if (val) coveragePaths.push(val);
      } else if (arg === "--lcov") {
        lcovPath = argv[++i];
      } else if (arg === "--mutation-report") {
        mutationReportPath = argv[++i];
      } else if (arg === "--stryker") {
        strykerPath = argv[++i];
      } else if (arg === "--expectations") {
        expectationsPath = argv[++i];
      } else if (arg === "--defects") {
        defectsPath = argv[++i];
      } else if (arg === "--sarif") {
        const val = argv[++i];
        if (val) sarifPaths.push(val);
      } else if (arg === "--knip") {
        const val = argv[++i];
        if (val) knipPaths.push(val);
      } else if (arg === "--libyear") {
        const val = argv[++i];
        if (val) libyearPaths.push(val);
      } else if (arg === "--external") {
        const val = argv[++i];
        if (val) externalReportPaths.push(val);
      } else if (arg === "--diff") {
        diffBase = argv[++i];
      } else if (arg === "--html") {
        htmlPath = argv[++i];
      } else if (arg === "--pr-comment") {
        const nextArg = argv[i + 1];
        if (nextArg && !nextArg.startsWith("-")) {
          prCommentDir = argv[++i];
        } else {
          prCommentDir = ".codefog";
        }
      } else if (arg === "--open") {
        openBrowser = true;
      } else if (arg === "--fail-on") {
        failOn = argv[++i] ?? "returned";
      } else if (!arg.startsWith("-")) {
        positional.push(arg);
      }
    }

    const validFailOnPolicies = new Set([
      "none",
      "returned",
      "doc-returned",
      "regression",
      "any-fog",
      "contested",
    ]);

    // Recover options if `npm exec` / `npx` consumed `--<flag>=<val>` into `npm_config_*` env vars
    if (process.env.npm_command === "exec") {
      const envVal = (k: string): string | undefined => {
        const v = process.env[k];
        return v && v !== "true" && v !== "false" ? v : undefined;
      };
      const envCov = envVal("npm_config_coverage");
      if (envCov) coveragePaths.push(envCov);
      const envLcov = envVal("npm_config_lcov");
      if (envLcov && !lcovPath) lcovPath = envLcov;
      const envMut = envVal("npm_config_mutation_report");
      if (envMut && !mutationReportPath) mutationReportPath = envMut;
      const envStryker = envVal("npm_config_stryker");
      if (envStryker && !strykerPath) strykerPath = envStryker;
      const envExpectations = envVal("npm_config_expectations");
      if (envExpectations && !expectationsPath) expectationsPath = envExpectations;
      const envDefects = envVal("npm_config_defects");
      if (envDefects && !defectsPath) defectsPath = envDefects;
      const envSarif = envVal("npm_config_sarif");
      if (envSarif) sarifPaths.push(envSarif);
      const envKnip = envVal("npm_config_knip");
      if (envKnip) knipPaths.push(envKnip);
      const envLibyear = envVal("npm_config_libyear");
      if (envLibyear) libyearPaths.push(envLibyear);
      const envExternal = envVal("npm_config_external");
      if (envExternal) externalReportPaths.push(envExternal);
      const envDiff = envVal("npm_config_diff");
      if (envDiff && !diffBase) diffBase = envDiff;
      const envHtml = envVal("npm_config_html");
      if (envHtml && !htmlPath) htmlPath = envHtml;
      const envPr = process.env.npm_config_pr_comment;
      if (envPr && !prCommentDir) {
        prCommentDir = envPr === "true" ? ".codefog" : envPr;
      }
      const envFailOn = envVal("npm_config_fail_on");
      if (envFailOn) failOn = envFailOn;
      if (process.env.npm_config_json === "true") jsonMode = true;
      if (process.env.npm_config_open === "true") openBrowser = true;
      if (process.env.npm_config_docs === "true") docsMode = true;
      if (process.env.npm_config_check_external_links === "true") checkExternalLinks = true;
      if (process.env.npm_config_run_docs === "true") runDocs = true;
    }

    // Classify positional arguments so that `npm exec` / `npx` stripping `--coverage`,
    // `--mutation-report`, `--fail-on`, `--html`, or `--diff` never mistakes a file path for `rootDir`
    for (const pos of positional) {
      if (validFailOnPolicies.has(pos)) {
        let isDir = false;
        try {
          isDir = (await fs.stat(path.resolve(rootDir, pos))).isDirectory();
        } catch {
          isDir = false;
        }
        if (!isDir) {
          failOn = pos;
          continue;
        }
      }

      if (
        /(?:outcomes\.json|mutation\.json|stryker\.json|mutations\.xml)$/i.test(pos) ||
        (/(?:mutant|mutation|stryker|pitest)/i.test(pos) && /\.(?:json|xml)$/i.test(pos))
      ) {
        mutationReportPath = pos;
        continue;
      }

      if (/\.html?$/i.test(pos)) {
        htmlPath = pos;
        continue;
      }

      if (/\.sarif(?:\.json)?$/i.test(pos) || /sarif.*\.(?:json|sarif)$/i.test(pos)) {
        sarifPaths.push(pos);
        continue;
      }

      if (/knip.*\.json$/i.test(pos)) {
        knipPaths.push(pos);
        continue;
      }

      if (/libyear.*\.json$/i.test(pos)) {
        libyearPaths.push(pos);
        continue;
      }

      if (
        /\.(?:out|info|lcov|cov|profdata)$/i.test(pos) ||
        /(?:coverage|lcov|jacoco).*\.(?:out|info|xml|txt|json)$/i.test(pos)
      ) {
        coveragePaths.push(pos);
        continue;
      }

      try {
        const st = await fs.stat(path.resolve(rootDir, pos));
        if (st.isFile()) {
          coveragePaths.push(pos);
        } else if (st.isDirectory()) {
          if (pos === ".codefog" || pos.endsWith("/.codefog")) {
            prCommentDir = pos;
          } else {
            rootDir = path.resolve(rootDir, pos);
          }
        }
      } catch {
        if (
          pos.startsWith("origin/") ||
          pos.startsWith("HEAD") ||
          pos === "main" ||
          pos === "master"
        ) {
          diffBase = pos;
        } else if (path.extname(pos)) {
          coveragePaths.push(pos);
        } else {
          rootDir = path.resolve(rootDir, pos);
        }
      }
    }

    if (!validFailOnPolicies.has(failOn)) {
      io.stderr(
        `Error: Invalid --fail-on policy '${failOn}'. Expected one of: returned, doc-returned, regression, any-fog, contested, none.\n`,
      );
      return 1;
    }

    const report = await analyzeRepository({
      rootDir,
      coveragePath: coveragePaths.length > 0 ? coveragePaths : undefined,
      lcovPath,
      mutationReportPath,
      strykerPath,
      expectationsPath,
      defectsPath,
      diffBase,
      docs: docsMode || undefined,
      checkExternalLinks: checkExternalLinks || undefined,
      runDocs: runDocs || undefined,
      sarifPath: sarifPaths.length > 0 ? sarifPaths : undefined,
      knipPath: knipPaths.length > 0 ? knipPaths : undefined,
      libyearPath: libyearPaths.length > 0 ? libyearPaths : undefined,
      externalReportPath: externalReportPaths.length > 0 ? externalReportPaths : undefined,
    });

    if (diffBase) {
      const diff = await computeDiffComparison(rootDir, diffBase, report);
      if (diff) {
        report.diff = diff;
      }
    }

    if (prCommentDir) {
      await writePrCommentArtifacts(rootDir, prCommentDir, report);
    }

    if (jsonMode) {
      if (htmlPath || openBrowser) {
        const writtenHtml = await writeHtmlFogMap(rootDir, report, htmlPath);
        if (openBrowser) openInDefaultBrowser(writtenHtml);
      }
      io.stdout(JSON.stringify(report, null, 2) + "\n");
    } else {
      const writtenHtml = await writeHtmlFogMap(rootDir, report, htmlPath);
      if (openBrowser) openInDefaultBrowser(writtenHtml);
      io.stdout(formatLevel1Summary(report));
    }

    if (failOn === "none") return 0;
    if (failOn === "contested" && report.summary.metrics.contestedOracles > 0) {
      return 1;
    }
    if (failOn === "returned" && report.summary.locByState["fog-returned"] > 0) {
      return 1;
    }
    if (failOn === "doc-returned") {
      const docReturnedCount =
        report.summary.docClaimsByState !== undefined
          ? report.summary.docClaimsByState["fog-returned"]
          : (
              await analyzeDocClaims({
                rootDir,
                checkExternalLinks: checkExternalLinks || undefined,
                runDocs: runDocs || undefined,
              })
            ).docClaimsByState["fog-returned"];
      if (docReturnedCount > 0) {
        return 1;
      }
    }
    if (
      failOn === "regression" &&
      (report.summary.locByState["fog-returned"] > 0 ||
        Boolean(report.diff?.coverageUpEvidenceDown) ||
        (report.diff?.weakenedFiles.length ?? 0) > 0)
    ) {
      return 1;
    }
    if (
      failOn === "any-fog" &&
      report.summary.locByState.fog +
        report.summary.locByState["fog-returned"] +
        report.summary.locByState["weak-evidence"] +
        report.summary.locByState["self-proof-fog"] >
        0
    ) {
      return 1;
    }
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.stderr(`Error: ${msg}\n`);
    return 1;
  }
}
