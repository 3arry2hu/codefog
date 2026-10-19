import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { analyzeRepository } from "./analyzer.js";
import { extractRuntimeFunctionFingerprints } from "./git-freshness.js";
import type { CodefogReport, DiffComparison, EvidenceState } from "./types.js";

const execFileAsync = promisify(execFile);

const STATE_QUALITY_RANK: Record<EvidenceState, number> = {
  verified: 5,
  "weak-evidence": 4,
  "self-proof-fog": 3,
  fog: 2,
  "fog-returned": 1,
};

const STATE_COLOR: Record<EvidenceState, string> = {
  verified: "#EBEFF4",
  "weak-evidence": "#BCCCE2",
  "self-proof-fog": "#6E88AA",
  fog: "#1D3656",
  "fog-returned": "#BD4900",
};

async function runGit(rootDir: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: rootDir });
    return stdout;
  } catch {
    return null;
  }
}

async function listTrackedFilesAtRef(rootDir: string, ref: string): Promise<string[]> {
  const out = await runGit(rootDir, ["ls-tree", "-r", "--name-only", ref]);
  if (!out) return [];
  return out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function analyzeBaselineAtRef(
  rootDir: string,
  baseRef: string,
): Promise<CodefogReport | null> {
  const tracked = await listTrackedFilesAtRef(rootDir, baseRef);
  if (tracked.length === 0) return null;

  const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "codefog-base-"));
  try {
    for (const relPath of tracked) {
      if (relPath.startsWith("node_modules/") || relPath.startsWith(".git/")) continue;
      const content = await runGit(rootDir, ["show", `${baseRef}:${relPath}`]);
      if (content === null) continue;
      const fullPath = path.join(tmpBase, relPath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content, "utf8");
    }

    const baseLcovPath = path.join(tmpBase, "coverage", "lcov.info");
    try {
      await fs.access(baseLcovPath);
    } catch {
      return null;
    }

    return await analyzeRepository({ rootDir: tmpBase });
  } catch {
    return null;
  } finally {
    await fs.rm(tmpBase, { recursive: true, force: true });
  }
}

export async function computeDiffComparison(
  rootDir: string,
  baseRef: string,
  currentReport: CodefogReport,
): Promise<DiffComparison | undefined> {
  const baseReport = await analyzeBaselineAtRef(rootDir, baseRef);
  if (!baseReport) return undefined;

  const baseFileMap = new Map(baseReport.files.map((f) => [f.path, f]));
  const fogReturnedFiles: string[] = [];
  const weakenedFiles: string[] = [];

  for (const curFile of currentReport.files) {
    const prevFile = baseFileMap.get(curFile.path);
    if (!prevFile) continue;

    // Also check if runtime AST changed compared to baseRef while state degraded or lacked fresh strong assertions
    const baseSource = await runGit(rootDir, ["show", `${baseRef}:${curFile.path}`]);
    const curSource = curFile.lines.join("\n");
    const baseFp = baseSource
      ? extractRuntimeFunctionFingerprints(baseSource, curFile.path)
      : new Map<string, string>();
    const curFp = extractRuntimeFunctionFingerprints(curSource, curFile.path);

    let runtimeChangedInFile = false;
    for (const [fnName, curSig] of curFp.entries()) {
      const prevSig = baseFp.get(fnName);
      if (prevSig !== undefined && prevSig !== curSig) {
        runtimeChangedInFile = true;
      }
    }

    const prevRank = STATE_QUALITY_RANK[prevFile.dominantState];
    const curRank = STATE_QUALITY_RANK[curFile.dominantState];

    if (
      curFile.dominantState === "fog-returned" ||
      (runtimeChangedInFile && prevFile.dominantState === "verified" && curFile.dominantState !== "verified")
    ) {
      curFile.diffStatus = "fog-returned";
      fogReturnedFiles.push(curFile.path);
    } else if (curRank < prevRank || curFile.trustScore < prevFile.trustScore) {
      curFile.diffStatus = "weakened";
      weakenedFiles.push(curFile.path);
    } else if (curRank > prevRank || curFile.trustScore > prevFile.trustScore) {
      curFile.diffStatus = "improved";
    } else {
      curFile.diffStatus = "unchanged";
    }
  }

  const lineCovDelta =
    currentReport.summary.metrics.lineCoveragePct -
    baseReport.summary.metrics.lineCoveragePct;
  const checkedCovDelta =
    currentReport.summary.metrics.checkedCoveragePct -
    baseReport.summary.metrics.checkedCoveragePct;
  const trustDelta = currentReport.summary.trustScore - baseReport.summary.trustScore;

  const coverageUpEvidenceDown =
    lineCovDelta >= 0 && (checkedCovDelta < 0 || trustDelta < 0);

  let alertHeadline: string;
  if (coverageUpEvidenceDown) {
    alertHeadline = `Coverage up, evidence down: Line coverage changed by ${lineCovDelta >= 0 ? "+" : ""}${lineCovDelta.toFixed(1)}%, while Checked Coverage changed by ${checkedCovDelta.toFixed(1)}% (Trust Score ${baseReport.summary.trustScore} -> ${currentReport.summary.trustScore}).`;
  } else if (fogReturnedFiles.length > 0 || weakenedFiles.length > 0) {
    alertHeadline = `Fog regression detected against ${baseRef}: ${fogReturnedFiles.length} file(s) with Fog Returned, ${weakenedFiles.length} weakened file(s).`;
  } else {
    alertHeadline = `Evidence held steady or improved against ${baseRef} (Trust Score ${baseReport.summary.trustScore} -> ${currentReport.summary.trustScore}).`;
  }

  return {
    baseRef,
    coverageUpEvidenceDown,
    alertHeadline,
    fogReturnedFiles,
    weakenedFiles,
    beforeSummary: {
      trustScore: baseReport.summary.trustScore,
      metrics: baseReport.summary.metrics,
      files: baseReport.files.map((f) => ({
        path: f.path,
        modulePath: f.modulePath,
        totalLoc: f.totalLoc,
        dominantState: f.dominantState,
        riskScore: f.riskScore,
      })),
    },
  };
}

export function renderPrDiffSvg(report: CodefogReport): string {
  const diff = report.diff;
  const baseLabel = diff ? `BEFORE (${diff.baseRef})` : "BEFORE (base)";
  const beforeScore = diff ? diff.beforeSummary.trustScore : report.summary.trustScore;
  const afterScore = report.summary.trustScore;

  const beforeFiles = diff?.beforeSummary.files ?? [];
  const afterFiles = report.files;

  function renderFileBlocks(
    items: Array<{ path: string; dominantState: EvidenceState; totalLoc: number }>,
    xOffset: number,
  ): string {
    return items
      .slice(0, 6)
      .map((item, idx) => {
        const y = 115 + idx * 42;
        const fill = STATE_COLOR[item.dominantState];
        const textFill =
          item.dominantState === "verified" || item.dominantState === "weak-evidence"
            ? "#0F172A"
            : "#FFFFFF";
        return `<g transform="translate(${xOffset}, ${y})">
          <rect width="340" height="34" rx="6" fill="${fill}" stroke="#CBD5E1" stroke-width="1" />
          <text x="12" y="21" font-family="ui-monospace, monospace" font-size="12" font-weight="600" fill="${textFill}">${item.path} (${item.dominantState})</text>
        </g>`;
      })
      .join("\n");
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="780" height="390" viewBox="0 0 780 390">
  <rect width="780" height="390" rx="12" fill="#F8FAFC" stroke="#E2E8F0" stroke-width="2" />
  <rect width="780" height="52" rx="12" fill="#0F172A" />
  <text x="24" y="32" font-family="Inter, sans-serif" font-size="16" font-weight="700" fill="#FFFFFF">codefog PR Fog Comparison</text>
  <text x="540" y="32" font-family="Inter, sans-serif" font-size="12" fill="#CBD5E1">Returned #BD4900 · Fog #1D3656 · Verified #EBEFF4</text>

  <!-- Left Column: BEFORE -->
  <text x="30" y="86" font-family="Inter, sans-serif" font-size="14" font-weight="700" fill="#0F172A">${baseLabel} · Trust ${beforeScore}/100</text>
  ${renderFileBlocks(beforeFiles, 30)}

  <!-- Right Column: AFTER -->
  <text x="410" y="86" font-family="Inter, sans-serif" font-size="14" font-weight="700" fill="#0F172A">AFTER (PR) · Trust ${afterScore}/100</text>
  ${renderFileBlocks(afterFiles, 410)}
</svg>`;
}

export function renderPrCommentMarkdown(report: CodefogReport): string {
  const diff = report.diff;
  const before = diff?.beforeSummary;
  const cur = report.summary;

  const fmtDelta = (nowVal: number, prevVal: number | undefined, suffix = ""): string => {
    if (prevVal === undefined) return `${nowVal}${suffix}`;
    const d = Math.round((nowVal - prevVal) * 10) / 10;
    const sign = d > 0 ? `+${d}` : `${d}`;
    return `${prevVal}${suffix} → **${nowVal}${suffix}** (${sign}${suffix})`;
  };

  const lines: string[] = [
    `## 🌫️ codefog PR Evidence Report`,
    "",
    diff?.coverageUpEvidenceDown
      ? `> ⚠️ **${diff.alertHeadline}**`
      : `> ℹ️ **${diff?.alertHeadline ?? "Repository fog scan completed."}**`,
    "",
    `![codefog Before vs After Fog Map](./pr-diff.svg)`,
    "",
    `| Metric | Before (${diff?.baseRef ?? "base"}) | After (PR) / Delta |`,
    `| :--- | :--- | :--- |`,
    `| **Trust Score** | ${before?.trustScore ?? cur.trustScore}/100 | ${fmtDelta(cur.trustScore, before?.trustScore)} |`,
    `| **Line Coverage** | ${before?.metrics.lineCoveragePct ?? cur.metrics.lineCoveragePct}% | ${fmtDelta(cur.metrics.lineCoveragePct, before?.metrics.lineCoveragePct, "%")} |`,
    `| **Branch Coverage** | ${before?.metrics.branchCoveragePct ?? cur.metrics.branchCoveragePct}% | ${fmtDelta(cur.metrics.branchCoveragePct, before?.metrics.branchCoveragePct, "%")} |`,
    `| **Checked Coverage** | ${before?.metrics.checkedCoveragePct ?? cur.metrics.checkedCoveragePct}% | ${fmtDelta(cur.metrics.checkedCoveragePct, before?.metrics.checkedCoveragePct, "%")} |`,
    `| **Mutation Score** | ${before?.metrics.mutationScorePct ?? cur.metrics.mutationScorePct}% | ${fmtDelta(cur.metrics.mutationScorePct, before?.metrics.mutationScorePct, "%")} |`,
    `| **Pseudo-tested Methods** | ${before?.metrics.pseudoTestedMethods ?? cur.metrics.pseudoTestedMethods} | ${fmtDelta(cur.metrics.pseudoTestedMethods, before?.metrics.pseudoTestedMethods)} |`,
    "",
  ];

  if (report.findings.length > 0) {
    lines.push(`### Top Fog Hotspots & Agent Findings`, "");
    for (const f of report.findings.slice(0, 5)) {
      lines.push(
        `- **[${f.id}] \`${f.location.file}:${f.location.startLine}-${f.location.endLine}\` (\`${f.title}\`)** — \`${f.state}\` (Risk **${f.riskScore}**)`,
        `  - ${f.reason}`,
        `  - Verify: \`${f.acceptanceCheck.command}\``,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

export async function writePrCommentArtifacts(
  rootDir: string,
  outDir: string,
  report: CodefogReport,
): Promise<{ svgPath: string; mdPath: string }> {
  const absOut = path.resolve(rootDir, outDir);
  await fs.mkdir(absOut, { recursive: true });
  const svgPath = path.join(absOut, "pr-diff.svg");
  const mdPath = path.join(absOut, "pr-comment.md");

  await fs.writeFile(svgPath, renderPrDiffSvg(report), "utf8");
  await fs.writeFile(mdPath, renderPrCommentMarkdown(report), "utf8");
  return { svgPath, mdPath };
}
