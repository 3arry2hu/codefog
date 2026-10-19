import * as path from "node:path";
import { analyzeRepository } from "./analyzer.js";
import type { CodefogReport } from "./types.js";

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
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
  argv: string[],
  io: CliIo = {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  },
): Promise<number> {
  try {
    let rootDir = process.cwd();
    let lcovPath: string | undefined;
    let strykerPath: string | undefined;
    let diffBase: string | undefined;
    let jsonMode = false;
    let failOn = "returned";

    const positional: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i]!;
      if (arg === "--json") {
        jsonMode = true;
      } else if (arg === "--root") {
        rootDir = path.resolve(argv[++i] ?? ".");
      } else if (arg === "--lcov") {
        lcovPath = argv[++i];
      } else if (arg === "--stryker") {
        strykerPath = argv[++i];
      } else if (arg === "--diff") {
        diffBase = argv[++i];
      } else if (arg === "--fail-on") {
        failOn = argv[++i] ?? "returned";
      } else if (!arg.startsWith("-")) {
        positional.push(arg);
      }
    }

    if (positional[0]) {
      rootDir = path.resolve(positional[0]);
    }

    const report = await analyzeRepository({
      rootDir,
      lcovPath,
      strykerPath,
      diffBase,
    });

    if (jsonMode) {
      io.stdout(JSON.stringify(report, null, 2) + "\n");
    } else {
      io.stdout(formatLevel1Summary(report));
    }

    if (failOn === "none") return 0;
    if (failOn === "returned" && report.summary.locByState["fog-returned"] > 0) {
      return 2;
    }
    if (
      failOn === "regression" &&
      (report.summary.locByState["fog-returned"] > 0 ||
        Boolean(report.diff?.coverageUpEvidenceDown) ||
        (report.diff?.weakenedFiles.length ?? 0) > 0)
    ) {
      return 2;
    }
    if (
      failOn === "any-fog" &&
      report.summary.locByState.fog +
        report.summary.locByState["fog-returned"] +
        report.summary.locByState["weak-evidence"] +
        report.summary.locByState["self-proof-fog"] >
        0
    ) {
      return 2;
    }
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.stderr(`Error: ${msg}\n`);
    return 1;
  }
}
