import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { analyzeRepository } from "./analyzer.js";
import { CODEFOG_COMMAND } from "./cli-command.js";
import { extractRuntimeFunctionFingerprints } from "./git-freshness.js";
import { STATE_COLORS, STATE_EVIDENCE_RANK, STATE_URGENCY_ORDER } from "./scoring.js";
import { detectDeletedDocClaimsAgainstRef } from "./verify.js";
import type {
  CodefogReport,
  DiffComparison,
  EvidenceState,
  FileSummary,
  LocByState,
} from "./types.js";

const execFileAsync = promisify(execFile);

async function runGit(rootDir: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: rootDir });
    return stdout;
  } catch {
    return null;
  }
}

export async function resolveBaseRef(rootDir: string, ref: string): Promise<string | null> {
  const sha = await runGit(rootDir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return sha?.trim() || null;
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
  options?: {
    docs?: boolean;
    checkExternalLinks?: boolean;
    runDocs?: boolean;
  },
): Promise<CodefogReport | null> {
  const tracked = await listTrackedFilesAtRef(rootDir, baseRef);
  if (tracked.length === 0) return null;

  const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "codefog-base-"));
  try {
    if (options?.docs) {
      const baseSha = (await runGit(rootDir, ["rev-parse", baseRef]))?.trim();
      if (baseSha) {
        try {
          await fs.cp(path.join(rootDir, ".git"), path.join(tmpBase, ".git"), {
            recursive: true,
          });
          await runGit(tmpBase, ["update-ref", "--no-deref", "HEAD", baseSha]);
        } catch {
          // fallback if .git copy is unavailable
        }
      }
    }

    for (const relPath of tracked) {
      if (relPath.startsWith("node_modules/") || relPath.startsWith(".git/")) continue;
      const content = await runGit(rootDir, ["show", `${baseRef}:${relPath}`]);
      if (content === null) continue;
      const fullPath = path.join(tmpBase, relPath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content, "utf8");
    }

    return await analyzeRepository({
      rootDir: tmpBase,
      ...(options?.docs ? { docs: true } : {}),
      ...(options?.checkExternalLinks ? { checkExternalLinks: true } : {}),
      ...(options?.runDocs ? { runDocs: true } : {}),
    });
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
  const docsEnabled = currentReport.summary.docTrustScore !== undefined;
  const baseReport = await analyzeBaselineAtRef(rootDir, baseRef, {
    docs: docsEnabled,
  });
  if (!baseReport) return undefined;

  const baseFileMap = new Map(baseReport.files.map((f) => [f.path, f]));
  const fogReturnedFiles: string[] = [];
  const weakenedFiles: string[] = [];
  const changedFiles: string[] = [];

  for (const curFile of currentReport.files) {
    const prevFile = baseFileMap.get(curFile.path);
    if (!prevFile) {
      changedFiles.push(curFile.path);
      if (curFile.dominantState === "fog-returned") {
        curFile.diffStatus = "fog-returned";
        fogReturnedFiles.push(curFile.path);
      } else if (curFile.dominantState === "verified") {
        curFile.diffStatus = "improved";
      } else {
        curFile.diffStatus = "weakened";
        weakenedFiles.push(curFile.path);
      }
      continue;
    }

    const baseSource = await runGit(rootDir, ["show", `${baseRef}:${curFile.path}`]);
    const curSource = curFile.lines.join("\n");
    if (baseSource === null || baseSource.replace(/\r\n/g, "\n") !== curSource) {
      changedFiles.push(curFile.path);
    }
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

    const prevRank = STATE_EVIDENCE_RANK[prevFile.dominantState];
    const curRank = STATE_EVIDENCE_RANK[curFile.dominantState];

    if (
      curFile.dominantState === "fog-returned" ||
      (runtimeChangedInFile &&
        prevFile.dominantState === "verified" &&
        curFile.dominantState !== "verified")
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

  const baseCoverageAvailable = baseReport.summary.metrics.coverageAvailable !== false;

  let alertHeadline: string;
  if (coverageUpEvidenceDown) {
    alertHeadline = `Coverage up, evidence down: Line coverage changed by ${lineCovDelta >= 0 ? "+" : ""}${lineCovDelta.toFixed(1)}%, while Checked Coverage changed by ${checkedCovDelta.toFixed(1)}% (Trust Score ${baseReport.summary.trustScore} -> ${currentReport.summary.trustScore}).`;
  } else if (fogReturnedFiles.length > 0) {
    alertHeadline = `Fog Returned detected against ${baseRef}: ${fogReturnedFiles.length} file(s) with Fog Returned, ${weakenedFiles.length} weakened file(s).`;
  } else if (weakenedFiles.length > 0) {
    alertHeadline = `Evidence weakened against ${baseRef}: ${weakenedFiles.length} weakened file(s), no Fog Returned.`;
  } else if (!baseCoverageAvailable) {
    alertHeadline = `No Fog Returned or weakened files against ${baseRef}. ${baseRef} has no coverage report, so coverage-derived metrics are not compared.`;
  } else {
    alertHeadline = `Evidence held steady or improved against ${baseRef} (Trust Score ${baseReport.summary.trustScore} -> ${currentReport.summary.trustScore}).`;
  }

  let newDocFogReturnedClaims = undefined;
  let deletedDocClaims = undefined;
  if (docsEnabled) {
    const baseReturnedKeys = new Set<string>();
    for (const bc of baseReport.docClaims ?? []) {
      if (bc.state === "fog-returned") {
        baseReturnedKeys.add(`${bc.file}:${bc.referentText}`);
        baseReturnedKeys.add(`${bc.file}:${bc.rawText}`);
      }
    }
    newDocFogReturnedClaims = (currentReport.docClaims ?? []).filter(
      (c) =>
        c.state === "fog-returned" &&
        !baseReturnedKeys.has(`${c.file}:${c.referentText}`) &&
        !baseReturnedKeys.has(`${c.file}:${c.rawText}`),
    );
    deletedDocClaims = await detectDeletedDocClaimsAgainstRef(rootDir, baseRef);
  }

  return {
    baseRef,
    coverageUpEvidenceDown,
    alertHeadline,
    fogReturnedFiles,
    weakenedFiles,
    changedFiles,
    beforeSummary: {
      trustScore: baseReport.summary.trustScore,
      ...(docsEnabled
        ? {
            docTrustScore: baseReport.summary.docTrustScore,
            totalDocClaims: baseReport.summary.totalDocClaims,
            docClaimsByState: baseReport.summary.docClaimsByState,
          }
        : {}),
      coverageAvailable: baseCoverageAvailable,
      metrics: baseReport.summary.metrics,
      files: baseReport.files.map((f) => ({
        path: f.path,
        modulePath: f.modulePath,
        totalLoc: f.totalLoc,
        dominantState: f.dominantState,
        riskScore: f.riskScore,
        trustScore: f.trustScore,
        locByState: f.locByState,
      })),
    },
    ...(docsEnabled && newDocFogReturnedClaims
      ? { newDocFogReturnedClaims }
      : {}),
    ...(docsEnabled && deletedDocClaims && deletedDocClaims.length > 0
      ? { deletedDocClaims }
      : {}),
  };
}

const SVG_WIDTH = 780;
const SVG_MAX_ROWS = 10;
const SVG_ROW_HEIGHT = 30;
const SVG_PATH_CHARS = 36;
const SVG_FONT = 'font-family="ui-sans-serif, -apple-system, Segoe UI, sans-serif"';
const SVG_MONO = 'font-family="ui-monospace, SFMono-Regular, Menlo, monospace"';

const SVG_LEGEND: Array<[EvidenceState, string]> = [
  ["fog-returned", "Fog Returned"],
  ["fog", "Fog"],
  ["self-proof-fog", "Self-proof Fog"],
  ["weak-evidence", "Weak Evidence"],
  ["verified", "Verified"],
];

function svgEsc(raw: string): string {
  return raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.ceil((max - 1) * 0.35);
  return `${text.slice(0, head)}…${text.slice(text.length - (max - 1 - head))}`;
}

function svgStateFill(state: EvidenceState): string {
  return state === "self-proof-fog" ? "url(#cf-hatch)" : STATE_COLORS[state];
}

function svgStateBar(loc: LocByState, x: number, w: number, cls: string): string {
  const total = STATE_URGENCY_ORDER.reduce((sum, s) => sum + (loc[s] ?? 0), 0);
  let offset = 0;
  const segs = STATE_URGENCY_ORDER.filter((s) => (loc[s] ?? 0) > 0)
    .map((s) => {
      const segW = (loc[s] / total) * w;
      const rect = `<rect x="${offset.toFixed(2)}" width="${segW.toFixed(2)}" height="14" fill="${svgStateFill(s)}" />`;
      offset += segW;
      return rect;
    })
    .join("");
  return `<g class="${cls}" transform="translate(${x}, 8)"><rect width="${w}" height="14" rx="3" fill="#FFFFFF" stroke="#CBD5E1" />${segs}</g>`;
}

function svgPill(label: string, x: number, fill: string, text: string): { svg: string; width: number } {
  const width = Math.round(label.length * 6.6 + 12);
  return {
    svg: `<rect x="${x}" y="8" width="${width}" height="15" rx="3" fill="${fill}" /><text x="${x + width / 2}" y="19" text-anchor="middle" ${SVG_MONO} font-size="10" font-weight="700" fill="${text}">${label}</text>`,
    width,
  };
}

export function renderPrDiffSvg(report: CodefogReport): string {
  const diff = report.diff;
  const baseLabel = diff ? `BEFORE (${diff.baseRef})` : "BEFORE (base)";
  const showBefore = diff !== undefined && diff.beforeSummary.coverageAvailable !== false;
  const returnedSet = new Set(diff?.fogReturnedFiles ?? []);
  const beforeByPath = new Map((diff?.beforeSummary.files ?? []).map((f) => [f.path, f]));
  const fileByPath = new Map(report.files.map((f) => [f.path, f]));

  const candidates = diff?.changedFiles
    ? diff.changedFiles.map((p) => fileByPath.get(p)).filter((f): f is FileSummary => f !== undefined)
    : report.files.filter((f) => f.totalLoc > 0);
  const isReturned = (f: FileSummary) => returnedSet.has(f.path) || f.diffStatus === "fog-returned";
  const byRisk = (a: FileSummary, b: FileSummary) => b.riskScore - a.riskScore || a.path.localeCompare(b.path);
  const ordered = [
    ...candidates.filter(isReturned).sort(byRisk),
    ...candidates.filter((f) => !isReturned(f)).sort(byRisk),
  ];
  const visible = ordered.slice(0, SVG_MAX_ROWS);
  const hidden = ordered.length - visible.length;

  const beforeX = 420;
  const afterX = showBefore ? 575 : 420;
  const barW = showBefore ? 140 : 260;

  let y = 66;
  const parts: string[] = [];
  parts.push(
    `<text x="20" y="${y}" ${SVG_FONT} font-size="12" fill="#475569">${diff ? `${svgEsc(baseLabel)} → AFTER (PR) · ${candidates.length} changed file(s)` : `AFTER (PR) · files by risk`}</text>`,
  );
  y += 22;
  SVG_LEGEND.forEach(([state, label], i) => {
    const x = 20 + i * 124;
    parts.push(
      `<rect x="${x}" y="${y - 9}" width="10" height="10" rx="2" fill="${svgStateFill(state)}" stroke="#94A3B8" stroke-width="0.5" />`,
      `<text x="${x + 15}" y="${y}" ${SVG_FONT} font-size="11" fill="#475569">${label}</text>`,
    );
  });
  if (diff && !showBefore) {
    y += 22;
    parts.push(
      `<text x="20" y="${y}" ${SVG_FONT} font-size="12" font-style="italic" fill="#475569">Base coverage unavailable: before-states not compared</text>`,
    );
  }
  y += 26;
  parts.push(
    `<text x="20" y="${y}" ${SVG_MONO} font-size="10" letter-spacing="1" fill="#64748B">FILE</text>`,
    ...(showBefore
      ? [`<text x="${beforeX}" y="${y}" ${SVG_MONO} font-size="10" letter-spacing="1" fill="#64748B">${svgEsc(baseLabel)}</text>`]
      : []),
    `<text x="${afterX}" y="${y}" ${SVG_MONO} font-size="10" letter-spacing="1" fill="#64748B">AFTER (PR)</text>`,
    `<text x="${SVG_WIDTH - 20}" y="${y}" text-anchor="end" ${SVG_MONO} font-size="10" letter-spacing="1" fill="#64748B">${showBefore ? "Δ TRUST" : "TRUST"}</text>`,
  );
  y += 6;

  visible.forEach((f, i) => {
    const prev = beforeByPath.get(f.path);
    const flags: Array<[string, string, string]> = [];
    if (diff && !prev) flags.push(["NEW", "#1D3656", "#FFFFFF"]);
    if (isReturned(f)) flags.push(["RETURNED", STATE_COLORS["fog-returned"], "#FFFFFF"]);
    else if (prev && f.diffStatus === "weakened") flags.push(["WEAKENED", "#E2E8F0", "#0F172A"]);
    let pillX = 300;
    const pills = flags.map(([label, fill, text]) => {
      const pill = svgPill(label, pillX, fill, text);
      pillX += pill.width + 4;
      return pill.svg;
    });
    let trustText: string;
    if (!showBefore) {
      trustText = `${f.trustScore}`;
    } else if (prev?.trustScore !== undefined) {
      const d = f.trustScore - prev.trustScore;
      trustText = d > 0 ? `+${d}` : `${d}`;
    } else {
      trustText = "—";
    }
    const beforeCell = showBefore
      ? prev?.locByState
        ? svgStateBar(prev.locByState, beforeX, barW, "bar-before")
        : `<text x="${beforeX}" y="19" ${SVG_FONT} font-size="11" fill="#94A3B8">—</text>`
      : "";
    parts.push(
      `<g class="row" data-path="${svgEsc(f.path)}" transform="translate(0, ${y + i * SVG_ROW_HEIGHT})">` +
        `<line x1="20" y1="0" x2="${SVG_WIDTH - 20}" y2="0" stroke="#E2E8F0" />` +
        `<text x="20" y="19" ${SVG_MONO} font-size="12" fill="#0F172A">${svgEsc(truncateMiddle(f.path, SVG_PATH_CHARS))}</text>` +
        pills.join("") +
        `<text x="${SVG_WIDTH - 20}" y="19" text-anchor="end" ${SVG_MONO} font-size="12" font-weight="600" fill="#0F172A">${trustText}</text>` +
        beforeCell +
        svgStateBar(f.locByState, afterX, barW, "bar-after") +
        `</g>`,
    );
  });
  y += Math.max(1, visible.length) * SVG_ROW_HEIGHT;
  if (visible.length === 0) {
    parts.push(`<text x="20" y="${y - 11}" ${SVG_FONT} font-size="12" fill="#64748B">No changed source files</text>`);
  }
  if (hidden > 0) {
    y += 24;
    parts.push(`<text x="20" y="${y - 6}" ${SVG_FONT} font-size="12" fill="#64748B">+${hidden} more files</text>`);
  }
  const height = y + 14;

  const trustHeadline =
    showBefore && diff
      ? `Trust ${diff.beforeSummary.trustScore} → ${report.summary.trustScore}`
      : `Trust ${report.summary.trustScore}/100`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_WIDTH}" height="${height}" viewBox="0 0 ${SVG_WIDTH} ${height}">
  <defs><pattern id="cf-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="${STATE_COLORS["self-proof-fog"]}" /><rect width="3" height="6" fill="#587294" /></pattern></defs>
  <rect x="1" y="1" width="${SVG_WIDTH - 2}" height="${height - 2}" rx="10" fill="#F8FAFC" stroke="#E2E8F0" />
  <rect x="1" y="1" width="${SVG_WIDTH - 2}" height="42" rx="10" fill="#0F172A" />
  <text x="20" y="28" ${SVG_FONT} font-size="15" font-weight="700" fill="#FFFFFF">codefog · PR evidence by changed file</text>
  <text x="${SVG_WIDTH - 20}" y="28" text-anchor="end" ${SVG_MONO} font-size="12" fill="#CBD5E1">${trustHeadline}</text>
  ${parts.join("\n  ")}
</svg>`;
}

/** The Doc Trust Score itself lives in the metrics table; this section lists doc claim changes. */
export function renderPrCommentDocSection(
  report: CodefogReport,
  _fmtDelta?: (nowVal: number, prevVal: number | undefined, suffix?: string) => string,
): string[] {
  const cur = report.summary;
  if (cur.docTrustScore === undefined) {
    return [];
  }
  const diff = report.diff;
  const newReturned =
    diff?.newDocFogReturnedClaims ??
    (report.docClaims ?? []).filter((c) => c.state === "fog-returned");
  const deletedClaims = diff?.deletedDocClaims ?? [];

  const section: string[] = [`### Documentation (Doc Claims)`, ""];

  if (newReturned.length > 0) {
    section.push(`- **New Doc Fog Returned (${newReturned.length})**:`);
    for (const c of newReturned) {
      const ref = c.referent ?? c.referents[0];
      const refPath = ref?.file ?? ref?.url ?? c.referentText;
      const refCommit = ref?.lastModifiedCommit ? ` @ \`${ref.lastModifiedCommit}\`` : "";
      section.push(
        `  - **[${c.id}] \`${c.file}:${c.startLine}\` (\`${c.text}\`, ${c.kind})** — \`fog-returned\` [RETURNED] · Referent: \`${refPath}\`${refCommit}`,
        `    - Verify: \`${CODEFOG_COMMAND} verify ${c.file} --lines ${c.blockStartLine}-${c.blockEndLine}\``,
      );
    }
  } else {
    section.push(`- **New Doc Fog Returned**: None`);
  }

  if (deletedClaims.length > 0) {
    section.push(`- **Deleted Doc Claims (${deletedClaims.length})**:`);
    for (const d of deletedClaims) {
      const referentDesc = d.referent.file ?? d.referent.symbol ?? d.claimText;
      section.push(
        `  - \`${d.file}:${d.line}\` (\`${d.claimText}\`, ${d.kind}) — Referent \`${referentDesc}\` still exists`,
      );
    }
  }

  section.push("");
  return section;
}

export function renderPrCommentMarkdown(report: CodefogReport): string {
  const diff = report.diff;
  const before = diff?.beforeSummary;
  const cur = report.summary;
  const hasDocs = cur.docTrustScore !== undefined;

  const baseCoverageUnavailable = before?.coverageAvailable === false;
  const metricRow = (
    label: string,
    nowVal: number,
    prevVal: number | undefined,
    cellSuffix: string,
    coverageDerived: boolean,
    deltaSuffix = cellSuffix,
  ): string => {
    if (prevVal === undefined || (coverageDerived && baseCoverageUnavailable)) {
      return `| **${label}** | — | **${nowVal}${cellSuffix}** | — |`;
    }
    const d = Math.round((nowVal - prevVal) * 10) / 10;
    const delta = `${d > 0 ? "+" : ""}${d}${deltaSuffix}`;
    return `| **${label}** | ${prevVal}${cellSuffix} | **${nowVal}${cellSuffix}** | ${delta} |`;
  };

  const alerted =
    diff !== undefined &&
    (diff.coverageUpEvidenceDown || diff.fogReturnedFiles.length > 0 || diff.weakenedFiles.length > 0);

  const lines: string[] = [
    `## 🌫️ codefog PR Evidence Report`,
    "",
    alerted ? "> [!WARNING]" : "> [!NOTE]",
    `> **${diff?.alertHeadline ?? "Repository fog scan completed."}**`,
    "",
    `![codefog PR evidence by changed file](./pr-diff.svg)`,
    "",
    `| Metric | Before (${diff?.baseRef ?? "base"}) | After (PR) | Δ |`,
    `| :--- | :--- | :--- | :--- |`,
    metricRow("Trust Score", cur.trustScore, before?.trustScore, "/100", true, ""),
    ...(hasDocs
      ? [metricRow("Doc Trust Score", cur.docTrustScore!, before?.docTrustScore, "/100", false, "")]
      : []),
    metricRow("Line Coverage", cur.metrics.lineCoveragePct, before?.metrics.lineCoveragePct, "%", true),
    metricRow("Branch Coverage", cur.metrics.branchCoveragePct, before?.metrics.branchCoveragePct, "%", true),
    metricRow("Checked Coverage", cur.metrics.checkedCoveragePct, before?.metrics.checkedCoveragePct, "%", true),
    metricRow("Mutation Score", cur.metrics.mutationScorePct, before?.metrics.mutationScorePct, "%", true),
    metricRow("Pseudo-tested Methods", cur.metrics.pseudoTestedMethods, before?.metrics.pseudoTestedMethods, "", true),
    ...(baseCoverageUnavailable
      ? ["", "> [!NOTE]", "> Base coverage unavailable: coverage-derived before-metrics are not compared."]
      : []),
    "",
  ];

  const codeFindings = hasDocs
    ? report.findings.filter((f) => f.subjectType !== "doc")
    : report.findings;

  if (codeFindings.length > 0) {
    lines.push(`### Top Findings`, "");
    for (const f of codeFindings.slice(0, 5)) {
      lines.push(
        `- **[${f.id}] \`${f.location.file}:${f.location.startLine}-${f.location.endLine}\` (\`${f.title}\`)** — \`${f.state}\` (Risk **${f.riskScore}**)`,
        `  - ${f.reason}`,
        `  - Verify: \`${f.acceptanceCheck.command}\``,
      );
    }
    lines.push("");
  }

  if (hasDocs) {
    lines.push(...renderPrCommentDocSection(report));
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
