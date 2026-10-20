import * as path from "node:path";
import { execFile } from "node:child_process";
import { analyzeRepository } from "./analyzer.js";
import { computeDiffComparison, writePrCommentArtifacts } from "./diff-pr.js";
import { writeHtmlFogMap } from "./html-report.js";
import { verifyTargetWithMutants } from "./verify.js";
import type { CodefogReport } from "./types.js";

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

  const lines: string[] = [
    `codefog | ${repository.name} (${repository.branch} @ ${repository.commit})`,
    `Trust Score: ${summary.trustScore}/100 | Files: ${summary.totalFiles} | LOC: ${summary.totalLoc} | Unverified (Fog): ${fogPct}%`,
    `Metrics: Line ${summary.metrics.lineCoveragePct}% | Branch ${summary.metrics.branchCoveragePct}% | Checked ${summary.metrics.checkedCoveragePct}% | Mutation ${summary.metrics.mutationScorePct}% | Pseudo-tested: ${summary.metrics.pseudoTestedMethods}`,
    `States: Returned=${summary.locByState["fog-returned"]} Fog=${summary.locByState.fog} Self-proof=${summary.locByState["self-proof-fog"]} Weak=${summary.locByState["weak-evidence"]} Verified=${summary.locByState.verified}`,
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
      io.stdout("1.1.0\n");
      return 0;
    }
    if (argv.includes("--help") || argv.includes("-h")) {
      io.stdout(
        [
          "codefog - Fog-first trust and risk map for TypeScript/JavaScript, Go, Rust, and Java repositories",
          "",
          "Usage:",
          "  codefog [rootDir] [options]",
          "  codefog verify <targetFile> [--lines start-end] [--mutants] [--test-cmd <cmd>]",
          "",
          "Options:",
          "  --coverage <path>     Path(s) to coverage file(s) (LCOV, Go coverprofile, JaCoCo XML; comma-separated or repeatable)",
          "  --lcov <path>         Alias for --coverage (default: auto-detects coverage/lcov.info, coverage.out, etc.)",
          "  --mutation-report <p> Path to mutation report (Stryker JSON, PITest XML, cargo-mutants JSON)",
          "  --stryker <path>      Alias for --mutation-report",
          "  --diff <baseRef>      Compare against base git ref (e.g. origin/main)",
          "  --html <path>         Output path for interactive HTML Fog Map (default: .codefog/report.html)",
          "  --pr-comment [dir]    Write PR comment Markdown and SVG artifacts",
          "  --json                Output full JSON report to stdout",
          "  --open                Open HTML Fog Map in default browser",
          "  --fail-on <policy>    Exit gate policy: returned | regression | any-fog | none (default: returned)",
          "  -v, --version         Print version",
          "  -h, --help            Print help",
          "",
        ].join("\n"),
      );
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

      for (let i = 1; i < argv.length; i++) {
        const arg = argv[i]!;
        if (arg === "--mutants") {
          mutants = true;
        } else if (arg === "--allow-source-change") {
          allowSourceChange = true;
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
        } else if (!arg.startsWith("-") && !targetFile) {
          targetFile = arg;
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

    const positional: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i]!;
      if (arg === "--json") {
        jsonMode = true;
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

    const validFailOnPolicies = new Set(["none", "returned", "regression", "any-fog"]);
    if (!validFailOnPolicies.has(failOn)) {
      io.stderr(
        `Error: Invalid --fail-on policy '${failOn}'. Expected one of: returned, regression, any-fog, none.\n`,
      );
      return 1;
    }

    if (positional[0]) {
      rootDir = path.resolve(positional[0]);
    }

    const report = await analyzeRepository({
      rootDir,
      coveragePath: coveragePaths.length > 0 ? coveragePaths : undefined,
      lcovPath,
      mutationReportPath,
      strykerPath,
      diffBase,
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
    if (failOn === "returned" && report.summary.locByState["fog-returned"] > 0) {
      return 1;
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
