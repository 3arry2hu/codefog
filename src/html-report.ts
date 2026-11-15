import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CODEFOG_COMMAND } from "./cli-command.js";
import { STATE_COLORS, STATE_URGENCY_ORDER } from "./scoring.js";
import { squarify, type TreemapRect } from "./treemap.js";
import type {
  CodefogReport,
  DocClaim,
  DocFileSummary,
  DocReferent,
  EvidenceState,
  FileSummary,
  Finding,
  LocByState,
  ModuleSummary,
} from "./types.js";

function escapeHtmlServer(raw: string): string {
  return raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatReferentServer(ref: DocReferent | undefined, fallbackReferent: string): string {
  if (!ref) {
    return `<code>${escapeHtmlServer(fallbackReferent)}</code>`;
  }
  const referentPath = ref.file ?? ref.url ?? fallbackReferent;
  const qualifier = ref.symbol
    ? ` (${escapeHtmlServer(ref.symbol)})`
    : ref.script
      ? ` (script: ${escapeHtmlServer(ref.script)})`
      : ref.anchor
        ? `#${escapeHtmlServer(ref.anchor)}`
        : "";
  const commitPart = ref.lastModifiedCommit
    ? ` @ <code>${escapeHtmlServer(ref.lastModifiedCommit)}</code>`
    : "";
  return `<code>${escapeHtmlServer(referentPath)}</code>${qualifier}${commitPart}`;
}

function formatClaimMarkerServer(claim: DocClaim): string {
  const badge =
    claim.state === "fog-returned"
      ? '<span class="badge-returned">RETURNED</span>'
      : `<span>[${claim.state}]</span>`;
  const allRefs: DocReferent[] = [];
  if (claim.referent) {
    allRefs.push(claim.referent);
  }
  for (const r of claim.referents) {
    if (!allRefs.includes(r)) {
      allRefs.push(r);
    }
  }
  const refHtml =
    allRefs.length > 0
      ? allRefs.map((r) => formatReferentServer(r, claim.referentText)).join(", ")
      : formatReferentServer(undefined, claim.referentText);
  return `<span class="doc-claim-inline" style="margin-left:8px;font-size:11px">${badge} · Referent: ${refHtml}</span>`;
}

function renderDocFileRowsServer(docFile: DocFileSummary): string {
  const claimsByLine = new Map<number, DocClaim[]>();
  for (const c of docFile.claims) {
    const list = claimsByLine.get(c.startLine) ?? [];
    list.push(c);
    claimsByLine.set(c.startLine, list);
  }
  return docFile.lines
    .map((lineText, idx) => {
      const ln = idx + 1;
      const st = docFile.lineStates[ln] ?? "verified";
      const escaped = escapeHtmlServer(lineText);
      const lineClaims = claimsByLine.get(ln) ?? [];
      const claimMarkers = lineClaims.map((c) => formatClaimMarkerServer(c)).join(" ");
      return `<tr class="line-${st}"><td class="ln-col" data-ln="${ln}">${ln}</td><td>${escaped}${claimMarkers ? " " + claimMarkers : ""}</td></tr>`;
    })
    .join("");
}

function renderStackedBarServer(loc: LocByState): string {
  const total =
    (loc["fog-returned"] || 0) +
    (loc.fog || 0) +
    (loc["self-proof-fog"] || 0) +
    (loc["weak-evidence"] || 0) +
    (loc.verified || 0) || 1;
  const p = (k: keyof LocByState) => (((loc[k] || 0) / total) * 100).toFixed(1) + "%";
  return (
    '<div class="stacked-bar">' +
    '<div class="bar-seg-returned" style="width:' +
    p("fog-returned") +
    '"></div>' +
    '<div class="bar-seg-fog" style="width:' +
    p("fog") +
    '"></div>' +
    '<div class="bar-seg-self-proof" style="width:' +
    p("self-proof-fog") +
    '"></div>' +
    '<div class="bar-seg-weak" style="width:' +
    p("weak-evidence") +
    '"></div>' +
    '<div class="bar-seg-verified" style="width:' +
    p("verified") +
    '"></div>' +
    "</div>"
  );
}

function renderModuleRowServer(m: ModuleSummary): string {
  const loc = m.locByState;
  const stateLine =
    `fog-returned: ${loc["fog-returned"]} · fog: ${loc.fog} · self-proof-fog: ${loc["self-proof-fog"]} · weak-evidence: ${loc["weak-evidence"]} · verified: ${loc.verified}`;
  return (
    `<div class="module-row" data-module="${escapeAttrServer(m.path)}" onclick="switchLevel(2)">` +
    `<div class="module-head">` +
    `<span class="module-path">${escapeHtmlServer(m.path)} <span class="module-meta">${m.totalFiles} files, ${m.verifiedFilesCollapsed} verified files collapsed</span></span>` +
    `<span class="module-meta">Trust ${m.trustScore}/100 · Max Risk ${m.maxRiskScore}</span>` +
    `</div>` +
    `<div class="module-states">${stateLine}</div>` +
    renderStackedBarServer(loc) +
    `</div>`
  );
}

const STATE_CHIP_LABELS: Record<EvidenceState, string> = {
  "fog-returned": "RETURNED",
  fog: "FOG",
  "self-proof-fog": "SELF-PROOF",
  "weak-evidence": "WEAK",
  verified: "VERIFIED",
};

function stateChipServer(state: EvidenceState): string {
  return `<span class="state-chip chip-${state}">${STATE_CHIP_LABELS[state]}</span>`;
}

function renderHeroCardServer(
  key: string,
  label: string,
  score: number,
  byState: LocByState,
  unitNote: string,
): string {
  return (
    `<div class="hero-card" data-metric="${key}">` +
    `<div class="kpi-label">${label}</div>` +
    `<div class="hero-val">${score}/100</div>` +
    `<div class="hero-sub">${unitNote}</div>` +
    renderStackedBarServer(byState) +
    `</div>`
  );
}

function renderMetricLineServer(report: CodefogReport): string {
  const m = report.summary.metrics;
  const coverage = m.coverageAvailable !== false;
  const mutation = m.mutationAvailable !== false;
  const noCoverage = "No coverage report found";
  const items: Array<{ key: string; label: string; value: string | null; na?: string }> = [
    {
      key: "line-branch",
      label: "Line / Branch",
      value: coverage ? `${m.lineCoveragePct}% / ${m.branchCoveragePct}%` : null,
      na: noCoverage,
    },
    { key: "checked", label: "Checked", value: coverage ? `${m.checkedCoveragePct}%` : null, na: noCoverage },
    {
      key: "mutation",
      label: "Mutation",
      value: mutation ? `${m.mutationScorePct}%` : null,
      na: "No mutation report (--mutation-report)",
    },
    {
      key: "pseudo-tested",
      label: "Pseudo-tested",
      value: coverage ? String(m.pseudoTestedMethods) : null,
      na: noCoverage,
    },
    { key: "contested", label: "Contested", value: String(m.contestedOracles) },
    ...(report.libyear
      ? [{ key: "libyear", label: "Dependency Drift", value: `${report.libyear.totalLibyears} libyears` }]
      : []),
  ];
  return (
    `<div class="metric-line">` +
    items
      .map(
        (i) =>
          `<div class="metric${i.value === null ? " metric-na" : ""}" data-metric="${i.key}"${i.value === null ? ` title="${i.na}"` : ""}>` +
          `<span class="metric-label">${i.label}</span><span class="metric-val">${i.value ?? "—"}</span></div>`,
      )
      .join("") +
    `</div>`
  );
}

const TOP_FINDINGS_VISIBLE = 10;

function renderTopFindingsServer(findings: Finding[]): string {
  if (findings.length === 0) {
    return `<div class="tf-empty">No active findings.</div>`;
  }
  const rows = findings.map((f, i) => {
    const loc = `${f.location.file}:${f.location.startLine}-${f.location.endLine}`;
    return (
      `<div class="tf-row${i >= TOP_FINDINGS_VISIBLE ? " tf-extra hidden" : ""}" data-file="${escapeAttrServer(f.location.file)}" data-finding="${escapeAttrServer(f.id)}" onclick="switchLevel(4, this.dataset.file, this.dataset.finding)">` +
      stateChipServer(f.state) +
      `<div class="tf-main"><span class="tf-symbol" title="${escapeAttrServer(f.title)}">${escapeHtmlServer(f.title)}</span>` +
      `<span class="tf-loc" title="${escapeAttrServer(loc)}">${escapeHtmlServer(loc)}</span></div>` +
      `<div class="tf-risk" title="Risk ${f.riskScore}/10"><span class="risk-bar"><i style="width:${Math.min(100, f.riskScore * 10)}%"></i></span><span class="risk-num">${f.riskScore}</span></div>` +
      `<button class="copy-agent-btn" onclick="copyAgentTask(this.closest('.tf-row').dataset.finding, this, event)">Copy as task for agent</button>` +
      `</div>`
    );
  });
  const more =
    findings.length > TOP_FINDINGS_VISIBLE
      ? `<button class="show-all-btn" onclick="showAllFindings(this)">Show all ${findings.length}</button>`
      : "";
  return rows.join("") + more;
}

const TREEMAP_WIDTH = 1000;
const TREEMAP_CODE_HEIGHT = 600;
const TREEMAP_DOC_HEIGHT = 400;
const TREEMAP_HOTSPOT_COUNT = 5;
const TREEMAP_LABEL_MIN_WIDTH = 100;
const TREEMAP_LABEL_MIN_HEIGHT = 34;

interface TreemapEntry {
  path: string;
  weight: number;
  byState: LocByState;
  riskScore: number;
  sizeLabel: string;
  sizeAttr: string;
  rank?: number;
}

function escapeAttrServer(raw: string): string {
  return escapeHtmlServer(raw).replace(/"/g, "&quot;");
}

function fmtNum(n: number, digits = 3): string {
  return String(Number(n.toFixed(digits)));
}

function renderTreemapTileServer(rect: TreemapRect<TreemapEntry>, mapHeight: number): string {
  const e = rect.item;
  const small = rect.w < TREEMAP_LABEL_MIN_WIDTH || rect.h < TREEMAP_LABEL_MIN_HEIGHT;
  const shares = STATE_URGENCY_ORDER.filter((s) => e.byState[s] > 0).map((s) => ({
    state: s,
    pct: (e.byState[s] / e.weight) * 100,
  }));
  const tooltip = [
    e.path,
    e.sizeLabel,
    `Risk ${e.riskScore}`,
    ...shares.map((s) => `${s.state} ${fmtNum(s.pct, 1)}%`),
  ].join(" · ");
  const classes = ["tm-tile", small ? "tm-small" : "", e.rank ? "tm-hotspot" : ""]
    .filter(Boolean)
    .join(" ");
  const style =
    `left:${fmtNum((rect.x / TREEMAP_WIDTH) * 100)}%;top:${fmtNum((rect.y / mapHeight) * 100)}%;` +
    `width:${fmtNum((rect.w / TREEMAP_WIDTH) * 100)}%;height:${fmtNum((rect.h / mapHeight) * 100)}%`;
  const segs = shares
    .map((s) => `<i class="seg seg-${s.state}" style="flex-basis:${fmtNum(s.pct)}%"></i>`)
    .join("");
  const badges =
    (e.rank ? `<span class="tm-rank">#${e.rank}</span>` : "") +
    (e.byState["fog-returned"] > 0 ? '<span class="badge-returned">RETURNED</span>' : "");
  return (
    `<div class="${classes}" data-path="${escapeAttrServer(e.path)}" ${e.sizeAttr} title="${escapeAttrServer(tooltip)}" style="${style}" onclick="switchLevel(4, this.dataset.path)">` +
    `<div class="tm-segs tm-segs-${rect.w >= rect.h ? "row" : "col"}">${segs}</div>` +
    (small
      ? ""
      : `<div class="tm-label"><strong>${escapeHtmlServer(e.path)}</strong><span>${escapeHtmlServer(e.sizeLabel)} · Risk ${e.riskScore}</span></div>`) +
    (badges ? `<div class="tm-badges">${badges}</div>` : "") +
    `</div>`
  );
}

function renderTreemapServer(entries: TreemapEntry[], mapId: string, mapHeight: number): string {
  const rects = squarify(
    entries.map((e) => ({ weight: e.weight, item: e })),
    TREEMAP_WIDTH,
    mapHeight,
  );
  return (
    `<div class="tm-canvas" data-map="${mapId}" style="aspect-ratio:${TREEMAP_WIDTH} / ${mapHeight}">` +
    rects.map((r) => renderTreemapTileServer(r, mapHeight)).join("") +
    `</div>`
  );
}

function codeTreemapEntries(files: FileSummary[]): TreemapEntry[] {
  const entries: TreemapEntry[] = files
    .filter((f) => f.totalLoc > 0 && f.locByState.verified < f.totalLoc)
    .map((f) => ({
      path: f.path,
      weight: f.totalLoc,
      byState: f.locByState,
      riskScore: f.riskScore,
      sizeLabel: `${f.totalLoc} LOC`,
      sizeAttr: `data-loc="${f.totalLoc}"`,
    }));
  [...entries]
    .filter((e) => e.riskScore > 0)
    .sort((a, b) => b.riskScore - a.riskScore || a.path.localeCompare(b.path))
    .slice(0, TREEMAP_HOTSPOT_COUNT)
    .forEach((e, idx) => {
      e.rank = idx + 1;
    });
  return entries;
}

function docTreemapEntries(docFiles: DocFileSummary[]): TreemapEntry[] {
  return docFiles
    .filter((d) => d.totalClaims > 0 && d.claimsByState.verified < d.totalClaims)
    .map((d) => ({
      path: d.path,
      weight: d.totalClaims,
      byState: d.claimsByState,
      riskScore: d.riskScore,
      sizeLabel: `Claims: ${d.totalClaims}`,
      sizeAttr: `data-claims="${d.totalClaims}"`,
    }));
}

function renderLevel3Server(report: CodefogReport, hasDocs: boolean): string {
  const codeEntries = codeTreemapEntries(report.files);
  const zeroLocCount = report.files.filter((f) => f.totalLoc === 0).length;
  const verifiedCount = report.files.filter(
    (f) => f.totalLoc > 0 && f.locByState.verified === f.totalLoc,
  ).length;
  const codeNote =
    `${verifiedCount} verified files collapsed` +
    (zeroLocCount > 0 ? ` · ${zeroLocCount} zero-LOC files not shown` : "");

  let docPanel = "";
  if (hasDocs) {
    const docFiles = report.docFiles ?? [];
    const docEntries = docTreemapEntries(docFiles);
    const docVerified = docFiles.filter(
      (d) => d.totalClaims > 0 && d.claimsByState.verified === d.totalClaims,
    ).length;
    const docEmpty = docFiles.filter((d) => d.totalClaims === 0).length;
    docPanel = `
      <div class="panel">
        <h2>Doc Fog Map <span class="panel-sub">Area = claims · fill = evidence mix</span></h2>
        ${docEntries.length > 0 ? renderTreemapServer(docEntries, "docs", TREEMAP_DOC_HEIGHT) : '<div class="tm-empty">No doc files with unverified claims.</div>'}
        <p class="tm-note">${docVerified} verified doc files collapsed${docEmpty > 0 ? ` · ${docEmpty} doc files without claims not shown` : ""}</p>
      </div>`;
  }

  return `
      <div class="panel">
        <h2>File Fog Map <span class="panel-sub">Area = executable lines · fill = evidence mix · #1–#${TREEMAP_HOTSPOT_COUNT} = top hotspots</span></h2>
        ${codeEntries.length > 0 ? renderTreemapServer(codeEntries, "code", TREEMAP_CODE_HEIGHT) : '<div class="tm-empty">No files with unverified code.</div>'}
        <p class="tm-note">${codeNote}</p>
      </div>${docPanel}`;
}

export function renderHtmlFogMap(report: CodefogReport): string {
  const safeJson = JSON.stringify(report).replace(/<\//g, "<\\/");
  const verifiedCollapsedTotal = report.modules.reduce(
    (acc, m) => acc + m.verifiedFilesCollapsed,
    0,
  );
  const hasDocs = report.summary.docTrustScore !== undefined;
  const hasExternal = report.external !== undefined || report.libyear !== undefined;
  const serverModulesHtml = report.modules.map((m) => renderModuleRowServer(m)).join("");
  const { summary } = report;
  const serverDocSourceRowsHtml = hasDocs
    ? (report.docFiles ?? []).map((df) => renderDocFileRowsServer(df)).join("")
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>codefog · ${report.repository.name} (${report.repository.branch} @ ${report.repository.commit})</title>
  <style>
    :root {
      --bg-canvas: #F8FAFC;
      --bg-card: #FFFFFF;
      --border-subtle: #E2E8F0;
      --border-strong: #CBD5E1;
      --sticky-offset: 88px;
      --text-primary: #0F172A;
      --text-secondary: #475569;
      --text-muted: #64748B;
      /* Five-State Fog-First OKLCH Slate Scale + Fog Returned Warning Orange */
      --state-verified: ${STATE_COLORS.verified};
      --state-weak: ${STATE_COLORS["weak-evidence"]};
      --state-self-proof: ${STATE_COLORS["self-proof-fog"]};
      --state-fog: ${STATE_COLORS.fog};
      --state-returned: ${STATE_COLORS["fog-returned"]};
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif;
      background: var(--bg-canvas);
      color: var(--text-primary);
      line-height: 1.5;
    }
    header {
      background: #0F172A;
      color: #F8FAFC;
      padding: 14px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 10px 24px;
      border-bottom: 1px solid #1E293B;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      font-weight: 700;
      font-size: 16px;
      letter-spacing: -0.01em;
    }
    .repo-pill {
      background: #1E293B;
      color: #CBD5E1;
      padding: 3px 10px;
      border-radius: 999px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
    }
    .legend {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px 14px;
      font-size: 12px;
      color: #CBD5E1;
    }
    .swatch {
      display: inline-block;
      width: 12px;
      height: 12px;
      border-radius: 3px;
      vertical-align: middle;
      margin-right: 5px;
      box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.5);
    }
    .swatch-verified { background: ${STATE_COLORS.verified}; }
    .swatch-weak { background: ${STATE_COLORS["weak-evidence"]}; }
    .swatch-self-proof {
      background: repeating-linear-gradient(-45deg, ${STATE_COLORS["self-proof-fog"]}, ${STATE_COLORS["self-proof-fog"]} 3px, #587294 3px, #587294 6px);
    }
    .swatch-fog { background: ${STATE_COLORS.fog}; }
    .swatch-returned { background: ${STATE_COLORS["fog-returned"]}; }
    .badge-returned {
      display: inline-block;
      background: ${STATE_COLORS["fog-returned"]};
      color: #FFFFFF;
      font-weight: 700;
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 4px;
      letter-spacing: 0.04em;
    }
    .sticky-top {
      position: sticky;
      top: 0;
      z-index: 20;
    }
    .level-summary {
      background: var(--bg-card);
      border-bottom: 1px solid var(--border-subtle);
      padding: 6px 24px;
      display: flex;
      align-items: center;
      gap: 20px;
      font-size: 13px;
    }
    .ls-label { color: var(--text-muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
    .ls-bar { flex: 1; max-width: 360px; }
    .ls-bar .stacked-bar { margin-top: 0; height: 8px; }
    .nav-levels {
      background: var(--bg-card);
      border-bottom: 1px solid var(--border-subtle);
      padding: 10px 24px;
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .nav-btn {
      background: #F1F5F9;
      border: 1px solid #CBD5E1;
      color: var(--text-primary);
      padding: 6px 14px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }
    .nav-btn.active {
      background: ${STATE_COLORS.fog};
      color: #FFFFFF;
      border-color: ${STATE_COLORS.fog};
    }
    main {
      max-width: 1400px;
      margin: 0 auto;
      padding: 20px 24px 48px;
    }
    .hero {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
      margin-bottom: 12px;
    }
    .hero-card {
      background: var(--bg-card);
      border: 1px solid var(--border-subtle);
      border-radius: 10px;
      padding: 16px 20px;
    }
    .hero-val {
      font-size: 40px;
      font-weight: 700;
      line-height: 1.1;
      margin-top: 4px;
      font-variant-numeric: tabular-nums;
    }
    .hero-sub { font-size: 12px; color: var(--text-muted); }
    .hero-card .stacked-bar { height: 14px; margin-top: 12px; }
    .metric-line {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 28px;
      padding: 10px 4px 18px;
      margin-bottom: 4px;
    }
    .metric { display: flex; align-items: baseline; gap: 8px; }
    .metric-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
    .metric-val { font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }
    .metric-na .metric-val { color: var(--text-muted); font-weight: 400; }
    .metric-na { cursor: help; }
    .report-warning {
      background: rgba(189, 73, 0, 0.08);
      border: 1px solid ${STATE_COLORS["fog-returned"]};
      border-radius: 8px;
      padding: 10px 14px;
      margin-bottom: 12px;
      font-size: 13px;
      white-space: pre-wrap;
    }
    .kpi-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
    }
    .grid-2col {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr);
      gap: 20px;
      align-items: start;
    }
    .grid-3col {
      display: grid;
      grid-template-columns: 300px minmax(0, 1fr) 360px;
      gap: 16px;
      align-items: start;
    }
    .panel {
      background: var(--bg-card);
      border: 1px solid var(--border-subtle);
      border-radius: 10px;
      padding: 18px;
      margin-bottom: 20px;
    }
    .panel h2 {
      margin: 0 0 12px;
      font-size: 15px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .module-row {
      padding: 10px 12px;
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      margin-bottom: 10px;
      cursor: pointer;
    }
    .module-row:hover { border-color: ${STATE_COLORS["self-proof-fog"]}; }
    .module-head { display: flex; justify-content: space-between; gap: 12px; font-weight: 600; }
    .module-path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
    .module-meta { font-size: 12px; font-weight: 400; color: var(--text-secondary); font-family: inherit; font-variant-numeric: tabular-nums; }
    .module-states { font-size: 12px; color: var(--text-muted); margin-top: 4px; }
    .state-chip {
      display: inline-block;
      flex: none;
      min-width: 74px;
      text-align: center;
      font: 700 10px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
      letter-spacing: 0.06em;
      padding: 0 6px;
      border-radius: 4px;
      border: 1px solid transparent;
    }
    .chip-fog-returned { background: ${STATE_COLORS["fog-returned"]}; color: #FFFFFF; }
    .chip-fog { background: ${STATE_COLORS.fog}; color: #FFFFFF; }
    .chip-self-proof-fog {
      background: repeating-linear-gradient(-45deg, ${STATE_COLORS["self-proof-fog"]}, ${STATE_COLORS["self-proof-fog"]} 3px, #587294 3px, #587294 6px);
      color: #FFFFFF;
    }
    .chip-weak-evidence { background: ${STATE_COLORS["weak-evidence"]}; color: var(--text-primary); }
    .chip-verified { background: ${STATE_COLORS.verified}; color: var(--text-secondary); border-color: var(--border-subtle); }
    .chip-contested { background: transparent; color: var(--text-primary); border-color: var(--text-secondary); min-width: 0; }
    .tf-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 7px 8px;
      border-bottom: 1px solid var(--border-subtle);
      cursor: pointer;
    }
    .tf-row:hover { background: var(--bg-canvas); }
    .tf-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .tf-symbol, .tf-loc { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tf-symbol { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; font-weight: 600; }
    .tf-loc { font-size: 11px; color: var(--text-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .tf-risk { flex: none; display: flex; align-items: center; gap: 6px; width: 92px; }
    .risk-bar { flex: 1; height: 6px; background: var(--border-subtle); border-radius: 3px; overflow: hidden; }
    .risk-bar i { display: block; height: 100%; background: var(--text-secondary); }
    .risk-num { font-size: 12px; font-variant-numeric: tabular-nums; width: 28px; text-align: right; }
    .tf-row .copy-agent-btn { margin-top: 0; flex: none; padding: 3px 8px; font-size: 11px; }
    .tf-empty { color: var(--text-muted); font-size: 13px; }
    .show-all-btn {
      margin-top: 10px;
      background: none;
      border: none;
      color: var(--text-secondary);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      text-decoration: underline;
    }
    .fc-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .stacked-bar {
      display: flex;
      height: 12px;
      border-radius: 6px;
      overflow: hidden;
      background: ${STATE_COLORS.verified};
      margin-top: 8px;
    }
    .bar-seg-returned { background: ${STATE_COLORS["fog-returned"]}; }
    .bar-seg-fog { background: ${STATE_COLORS.fog}; }
    .bar-seg-self-proof {
      background: repeating-linear-gradient(-45deg, ${STATE_COLORS["self-proof-fog"]}, ${STATE_COLORS["self-proof-fog"]} 4px, #587294 4px, #587294 8px);
    }
    .bar-seg-weak { background: ${STATE_COLORS["weak-evidence"]}; }
    .bar-seg-verified { background: ${STATE_COLORS.verified}; }
    .panel-sub {
      font-size: 12px;
      font-weight: 400;
      color: var(--text-muted);
    }
    .tm-canvas {
      position: relative;
      width: 100%;
      background: var(--bg-card);
    }
    .tm-tile {
      position: absolute;
      border: 2px solid var(--bg-card);
      border-radius: 5px;
      overflow: hidden;
      cursor: pointer;
    }
    .tm-tile:hover { border-color: var(--text-secondary); }
    .tm-tile.tm-hotspot { border: 3px solid var(--text-primary); }
    .tm-segs { position: absolute; inset: 0; display: flex; }
    .tm-segs-row { flex-direction: row; }
    .tm-segs-col { flex-direction: column; }
    .seg { display: block; flex-grow: 0; flex-shrink: 0; }
    .seg-fog-returned { background: ${STATE_COLORS["fog-returned"]}; }
    .seg-fog { background: ${STATE_COLORS.fog}; }
    .seg-self-proof-fog {
      background: repeating-linear-gradient(-45deg, ${STATE_COLORS["self-proof-fog"]}, ${STATE_COLORS["self-proof-fog"]} 4px, #587294 4px, #587294 8px);
    }
    .seg-weak-evidence { background: ${STATE_COLORS["weak-evidence"]}; }
    .seg-verified { background: ${STATE_COLORS.verified}; }
    .tm-label {
      position: absolute;
      left: 5px;
      top: 5px;
      max-width: calc(100% - 10px);
      background: rgba(255, 255, 255, 0.9);
      color: var(--text-primary);
      border-radius: 4px;
      padding: 2px 6px;
      font-size: 11px;
      line-height: 1.35;
    }
    .tm-label strong {
      display: block;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .tm-label span { color: var(--text-secondary); white-space: nowrap; }
    .tm-badges {
      position: absolute;
      right: 5px;
      bottom: 5px;
      display: flex;
      gap: 4px;
      align-items: center;
    }
    .tm-rank {
      background: var(--text-primary);
      color: var(--bg-card);
      font: 700 11px ui-monospace, SFMono-Regular, Menlo, monospace;
      padding: 1px 6px;
      border-radius: 4px;
    }
    .tm-small .tm-badges { right: 2px; bottom: 2px; }
    .tm-small .tm-rank { font-size: 9px; padding: 0 3px; }
    .tm-small .badge-returned { font-size: 0; width: 8px; height: 8px; padding: 0; border-radius: 50%; }
    .tm-note { margin: 10px 0 0; font-size: 12px; color: var(--text-muted); }
    .tm-empty { padding: 24px; text-align: center; color: var(--text-muted); font-size: 13px; }
    @media (max-width: 640px) {
      .tm-canvas { aspect-ratio: 1 / 1 !important; }
      .tm-label { display: none; }
      .tm-badges { right: 2px; bottom: 2px; }
      .tm-rank { font-size: 9px; padding: 0 3px; }
      .tm-tile .badge-returned { font-size: 0; width: 8px; height: 8px; padding: 0; border-radius: 50%; }
    }
    .source-table {
      width: 100%;
      border-collapse: collapse;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
    }
    .source-table td {
      padding: 3px 8px;
      vertical-align: top;
      white-space: pre-wrap;
    }
    .ln-col {
      width: 48px;
      text-align: right;
      color: var(--text-muted);
      user-select: none;
      padding-right: 12px !important;
    }
    .line-fog-returned .ln-col { box-shadow: inset -4px 0 0 var(--state-returned); }
    .line-fog .ln-col { box-shadow: inset -4px 0 0 var(--state-fog); }
    .line-weak-evidence .ln-col { box-shadow: inset -4px 0 0 var(--state-weak); }
    .line-self-proof-fog .ln-col {
      background: repeating-linear-gradient(-45deg, var(--state-self-proof) 0 2px, #587294 2px 4px) right / 4px 100% no-repeat;
    }
    .line-fog-returned > td:not(.ln-col) { background: rgba(189, 73, 0, 0.16); }
    .line-fog > td:not(.ln-col) { background: rgba(29, 54, 86, 0.14); }
    .line-self-proof-fog > td:not(.ln-col) { background: rgba(110, 136, 170, 0.10); }
    .line-weak-evidence > td:not(.ln-col) { background: rgba(188, 204, 226, 0.16); }
    .line-verified > td:not(.ln-col) { color: var(--text-secondary); }
    .code-wrap {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 12px;
      gap: 8px;
      align-items: start;
    }
    .minimap {
      position: sticky;
      top: var(--sticky-offset);
      height: calc(100vh - var(--sticky-offset) - 48px);
      background: var(--bg-canvas);
      border: 1px solid var(--border-subtle);
      border-radius: 3px;
    }
    .mm-mark { position: absolute; left: 0; right: 0; min-height: 2px; cursor: pointer; }
    .mm-fog-returned { background: var(--state-returned); }
    .mm-fog { background: var(--state-fog); }
    .mm-self-proof-fog { background: repeating-linear-gradient(-45deg, var(--state-self-proof) 0 2px, #587294 2px 4px); }
    .mm-weak-evidence { background: var(--state-weak); }
    .l4-side {
      position: sticky;
      top: var(--sticky-offset);
      max-height: calc(100vh - var(--sticky-offset) - 16px);
      overflow: auto;
    }
    .fc-title {
      flex: 1;
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .mutant-inline-row td {
      background: #FFF7ED;
      color: #9A3412;
      border-left: 4px solid ${STATE_COLORS["fog-returned"]};
      font-size: 11px;
      padding: 4px 12px;
    }
    .finding-card {
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 12px;
      background: #F8FAFC;
      cursor: pointer;
    }
    .finding-card.active {
      border-color: ${STATE_COLORS.fog};
      box-shadow: 0 0 0 1px ${STATE_COLORS.fog};
    }
    .copy-agent-btn {
      margin-top: 8px;
      background: transparent;
      color: var(--text-primary);
      border: 1px solid var(--border-strong);
      border-radius: 6px;
      padding: 5px 11px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    .copy-agent-btn:hover { border-color: var(--text-primary); }
    .finding-card.active .copy-agent-btn {
      background: var(--text-primary);
      color: var(--bg-card);
      border-color: var(--text-primary);
    }
    @media (max-width: 640px) {
      header { padding: 12px 16px; }
      .nav-levels, .level-summary { padding-left: 16px; padding-right: 16px; }
      .nav-levels { flex-wrap: nowrap; overflow-x: auto; }
      .nav-btn { flex: none; }
      main { padding: 14px 12px 40px; }
      .hero-card { padding: 12px 14px; }
      .hero-val { font-size: 30px; }
      .metric-line { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 12px; }
      .metric { flex-direction: column; gap: 0; }
      .grid-2col, .grid-3col { grid-template-columns: minmax(0, 1fr); }
      .tf-row .copy-agent-btn { display: none; }
      .tf-risk { width: 64px; }
      .module-head { flex-direction: column; gap: 2px; }
      .l4-side { position: static; max-height: none; }
      .code-wrap { grid-template-columns: minmax(0, 1fr); }
      .minimap { display: none; }
    }
    .hidden { display: none !important; }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <span>codefog</span>
      <span class="repo-pill">${report.repository.name} · ${report.repository.branch} @ ${report.repository.commit}</span>
    </div>
    <div class="legend">
      <span><i class="swatch swatch-returned"></i>Fog Returned</span>
      <span><i class="swatch swatch-fog"></i>Fog</span>
      <span><i class="swatch swatch-self-proof"></i>Self-proof Fog</span>
      <span><i class="swatch swatch-weak"></i>Weak Evidence</span>
      <span><i class="swatch swatch-verified"></i>Verified</span>
    </div>
  </header>

  <div class="sticky-top">
    <nav class="nav-levels">
      <button class="nav-btn active" data-level="1" onclick="switchLevel(1)">Level 1: Repository</button>
      <button class="nav-btn" data-level="2" onclick="switchLevel(2)">Level 2: Module</button>
      <button class="nav-btn" data-level="3" onclick="switchLevel(3)">Level 3: File Map</button>
      <button class="nav-btn" data-level="4" onclick="switchLevel(4)">Level 4: Source & Evidence</button>
    </nav>
    <div id="level-summary" class="level-summary hidden">
      <span class="ls-item"><span class="ls-label">Trust</span> <strong>${summary.trustScore}/100</strong></span>${
        hasDocs
          ? `
      <span class="ls-item"><span class="ls-label">Doc Trust</span> <strong>${summary.docTrustScore}/100</strong></span>`
          : ""
      }
      <div class="ls-bar">${renderStackedBarServer(summary.locByState)}</div>
    </div>
  </div>

  <main>
    <!-- Level 1: Repository Overview -->
    <section id="view-level-1" class="level-section">${(report.warnings ?? [])
      .map((w) => `\n      <div class="report-warning">${escapeHtmlServer(w)}</div>`)
      .join("")}
      <div class="hero">${renderHeroCardServer(
        "trust",
        "Trust Score",
        summary.trustScore,
        summary.locByState,
        `${summary.totalLoc} executable lines`,
      )}${
        hasDocs
          ? renderHeroCardServer(
              "doc-trust",
              "Doc Trust Score",
              summary.docTrustScore!,
              summary.docClaimsByState!,
              `${summary.totalDocClaims ?? 0} doc claims`,
            )
          : ""
      }</div>
      ${renderMetricLineServer(report)}${
      report.libyear
        ? `
      <div class="panel">
        <h2>Dependency Drift (libyear) <span>${report.libyear.totalLibyears} libyears</span></h2>
        <div class="module-states">${report.libyear.dependencies.map((d) => `<code>${escapeHtmlServer(d.name)}</code>: ${d.libyears} libyears`).join(" · ")}</div>
      </div>`
        : ""
    }
      <div class="grid-2col">
        <div class="panel">
          <h2>Modules by Fog</h2>
          <div id="l1-modules">${serverModulesHtml}</div>
        </div>
        <div class="panel">
          <h2>Top Findings</h2>
          <div id="l1-findings">${renderTopFindingsServer(report.findings)}</div>
        </div>
      </div>
    </section>

    <!-- Level 2: Module Drilldown -->
    <section id="view-level-2" class="level-section hidden">
      <div class="panel">
        <h2>Module Breakdown <span class="panel-sub">${verifiedCollapsedTotal} verified files collapsed</span></h2>
        <div id="l2-submodules">${serverModulesHtml}</div>
      </div>
    </section>

    <!-- Level 3: File Map Treemap -->
    <section id="view-level-3" class="level-section hidden">${renderLevel3Server(report, hasDocs)}
    </section>

    <!-- Level 4: Three-Column Source & Evidence View -->
    <section id="view-level-4" class="level-section hidden">
      <div class="grid-3col">
        <!-- Left Column: Findings List -->
        <div class="panel l4-side">
          <h2>Findings List</h2>
          <div id="l4-findings"></div>
          ${
            report.findings.length === 0
              ? `<div class="finding-card">No active findings. Example command: <code>${CODEFOG_COMMAND} verify &lt;file&gt; --mutants</code> <button class="copy-agent-btn">Copy as task for agent</button></div>`
              : ""
          }
        </div>
        <!-- Center Column: Source Code & Inline Surviving Mutants -->
        <div class="panel">
          <h2 id="l4-file-title">Source View</h2>
          <div class="code-wrap">
            <table class="source-table" id="l4-source-table">${serverDocSourceRowsHtml}</table>
            <div id="l4-minimap" class="minimap"></div>
          </div>
        </div>
        <!-- Right Column: Selected Finding Detail & Copy as task for agent -->
        <div class="panel l4-side">
          <h2>Finding Detail & Agent Task</h2>
          <div id="l4-finding-detail"></div>
        </div>
      </div>
    </section>
  </main>

  <script>
    const REPORT = ${safeJson};

    function switchLevel(level, filePath, findingId) {
      document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.classList.toggle('active', Number(btn.dataset.level) === level);
      });
      document.querySelectorAll('.level-section').forEach((sec, idx) => {
        sec.classList.toggle('hidden', idx + 1 !== level);
      });
      document.getElementById('level-summary').classList.toggle('hidden', level === 1);
      if (level === 4) {
        renderLevel4(filePath || (REPORT.files[0] && REPORT.files[0].path), findingId);
      }
    }

    function buildFindingMarkdown(f) {
      return [
        "### Codefog Finding [" + f.id + "]: " + f.title + " (" + f.state + ")",
        "- **Location**: " + f.location.file + ":" + f.location.startLine + "-" + f.location.endLine + " (" + f.location.symbol + ")",
        "- **Risk Score**: " + f.riskScore + "/10",
        "- **Reason**: " + f.reason,
        "- **Suggested Action**: " + f.suggestedAction,
        "- **Acceptance Check**: " + f.acceptanceCheck.command
      ].join("\\n");
    }

    function copyAgentTask(findingId, btn, evt) {
      if (evt) evt.stopPropagation();
      const f = REPORT.findings.find(x => x.id === findingId);
      if (!f) return;
      const md = buildFindingMarkdown(f);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(md);
      }
      const prev = btn.textContent;
      btn.textContent = "Copied!";
      setTimeout(() => { btn.textContent = prev; }, 1500);
    }

    const STATE_CHIP_LABELS = ${JSON.stringify(STATE_CHIP_LABELS)};

    function stateChip(state) {
      return '<span class="state-chip chip-' + state + '">' + (STATE_CHIP_LABELS[state] || state) + '</span>';
    }

    function showAllFindings(btn) {
      document.querySelectorAll('.tf-extra').forEach(el => el.classList.remove('hidden'));
      btn.remove();
    }

    function initViews() {${
        hasDocs
          ? `

      const initialFile = (REPORT.docFiles && REPORT.docFiles[0] && REPORT.docFiles[0].path) || (REPORT.files[0] && REPORT.files[0].path);
      if (initialFile) {
        renderLevel4(initialFile);
      }`
          : `

      if (REPORT.files[0]) {
        renderLevel4(REPORT.files[0].path);
      }`
      }
    }${
      hasDocs
        ? `

    function formatReferentClient(ref, fallbackReferent) {
      if (!ref) return '<code>' + fallbackReferent + '</code>';
      const referentPath = ref.file || ref.url || fallbackReferent;
      const qualifier = ref.symbol ? ' (' + ref.symbol + ')' : ref.script ? ' (script: ' + ref.script + ')' : ref.anchor ? '#' + ref.anchor : '';
      const commitPart = ref.lastModifiedCommit ? ' @ <code>' + ref.lastModifiedCommit + '</code>' : '';
      return '<code>' + referentPath + '</code>' + qualifier + commitPart;
    }`
        : ""
    }

    function renderFindingDetail(f) {
      const detailEl = document.getElementById("l4-finding-detail");
      if (!f) {
        detailEl.innerHTML = '<div style="font-size:13px;color:#64748B">Select a finding to inspect evidence & agent remediation instructions.</div>';
        return;
      }
      const mutantsHtml = (f.evidence.survivingMutants || []).map(m =>
        '<li>Line ' + m.line + ': <code>' + m.original + '</code> → <code>' + m.mutated + '</code> (survived ' + m.testsRun + ' tests)</li>'
      ).join("");${
        hasExternal || hasDocs
          ? `
      const externalHtml = (f.externalIssues || []).map(ext =>
        '<li>[' + ext.source + '] <code>' + ext.ruleId + '</code> (line ' + ext.line + '): ' + ext.message + '</li>'
      ).join("");`
          : ""
      }${
        hasDocs
          ? `
      const matchedClaim = (REPORT.docClaims || []).find(c => c.id === f.id);
      const claimRefHtml = matchedClaim
        ? '<div style="font-size:12px;margin-top:4px"><strong>Referent:</strong> ' + formatReferentClient(matchedClaim.referent || (matchedClaim.referents && matchedClaim.referents[0]), matchedClaim.referentText) + '</div>'
        : '';`
          : ""
      }
      detailEl.innerHTML =
        '<div class="finding-card active">' +
          '<div class="fc-head">' +
            stateChip(f.state) +
            (f.evidence && f.evidence.oracleContest ? ' <span class="state-chip chip-contested">CONTESTED</span>' : '') +
            findingTitle(f) +
          '</div>' +
          '<div style="font-size:12px;margin-top:6px"><strong>Location:</strong> ' + f.location.file + ':' + f.location.startLine + '-' + f.location.endLine + '</div>' +${
            hasDocs
              ? `
          claimRefHtml +`
              : ""
          }
          '<div style="font-size:12px;margin-top:4px"><strong>Risk Score:</strong> ' + f.riskScore + '/10</div>' +
          '<div style="font-size:12px;margin-top:4px"><strong>Why it is in fog:</strong> ' + f.reason + '</div>' +
          '<div style="font-size:12px;margin-top:4px"><strong>Evidence:</strong> Executed by ' + f.evidence.executedByTests + ' test(s), ' + f.evidence.assertionsOnOutcome + ' outcome assertion(s)' + (f.evidence.pseudoTested ? ' [PSEUDO-TESTED]' : '') + '</div>' +
          (mutantsHtml ? '<ul style="font-size:12px;margin:6px 0;padding-left:18px">' + mutantsHtml + '</ul>' : '') +${
            hasExternal || hasDocs
              ? `
          (externalHtml ? '<div style="font-size:12px;margin-top:4px"><strong>External Overlay:</strong><ul style="font-size:12px;margin:4px 0;padding-left:18px">' + externalHtml + '</ul></div>' : '') +`
              : ""
          }
          '<div style="font-size:12px;margin-top:6px"><strong>Suggested Action:</strong> ' + f.suggestedAction + '</div>' +
          '<div style="font-size:11px;margin-top:6px;font-family:monospace;background:#E2E8F0;padding:6px;border-radius:4px">' + f.acceptanceCheck.command + '</div>' +
          '<button class="copy-agent-btn" onclick="copyAgentTask(\\'' + f.id + '\\', this, event)">Copy as task for agent</button>' +
        '</div>';
    }

    function renderLevel4(filePath, selectedFindingId) {${
      hasDocs
        ? `
      const docFile = (REPORT.docFiles || []).find(df => df.path === filePath);
      const file = docFile || REPORT.files.find(f => f.path === filePath) || (REPORT.docFiles && REPORT.docFiles[0]) || REPORT.files[0];`
        : `
      const file = REPORT.files.find(f => f.path === filePath) || REPORT.files[0];`
    }
      if (!file) return;
      document.getElementById("l4-file-title").textContent = file.path + " (Trust " + file.trustScore + "/100)";

      // Build map of surviving mutants by line number for inline source annotation
      const mutantsByLine = {};${
        hasExternal || hasDocs
          ? `
      const externalByLine = {};`
          : ""
      }${
        hasDocs
          ? `
      const claimsByLine = {};`
          : ""
      }
      (file.regions || []).forEach(r => {
        (r.survivingMutants || []).forEach(m => {
          mutantsByLine[m.line] = mutantsByLine[m.line] || [];
          mutantsByLine[m.line].push(m);
        });${
          hasExternal || hasDocs
            ? `
        (r.externalIssues || []).forEach(ext => {
          const ln = ext.line || r.startLine;
          externalByLine[ln] = externalByLine[ln] || [];
          externalByLine[ln].push(ext);
        });`
            : ""
        }
      });${
        hasDocs
          ? `
      (file.claims || []).forEach(c => {
        claimsByLine[c.startLine] = claimsByLine[c.startLine] || [];
        claimsByLine[c.startLine].push(c);
      });`
          : ""
      }

      const table = document.getElementById("l4-source-table");
      table.innerHTML = (file.lines || []).map((lineText, idx) => {
        const ln = idx + 1;
        const st = (file.lineStates && file.lineStates[ln]) || "verified";
        const escaped = lineText.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");${
          hasDocs
            ? `
        const lineClaims = claimsByLine[ln] || [];
        const claimInlineHtml = lineClaims.map(c => {
          const badge = c.state === "fog-returned" ? '<span class="badge-returned">RETURNED</span>' : '<span>[' + c.state + ']</span>';
          const refHtml = formatReferentClient(c.referent || (c.referents && c.referents[0]), c.referentText);
          return ' <span class="doc-claim-inline" style="margin-left:8px;font-size:11px">' + badge + ' · Referent: ' + refHtml + '</span>';
        }).join("");`
            : ""
        }
        const lineMutants = mutantsByLine[ln] || [];
        const mutantRows = lineMutants.map(m =>
          '<tr class="mutant-inline-row"><td class="ln-col">↳</td><td>⚠️ Surviving Mutant [' + m.id + ']: <code>' + m.original + '</code> → <code>' + m.mutated + '</code> (survived ' + m.testsRun + ' tests)</td></tr>'
        ).join("");${
          hasExternal || hasDocs
            ? `
        const lineExternal = externalByLine[ln] || [];
        const externalRows = lineExternal.map(ext =>
          '<tr class="mutant-inline-row"><td class="ln-col">↳</td><td>[' + ext.source + '] <code>' + ext.ruleId + '</code>: ' + ext.message + '</td></tr>'
        ).join("");
        return '<tr class="line-' + st + '"><td class="ln-col" data-ln="' + ln + '">' + ln + '</td><td>' + escaped +${hasDocs ? " claimInlineHtml +" : ""} '</td></tr>' + mutantRows + externalRows;`
            : `
        return '<tr class="line-' + st + '"><td class="ln-col" data-ln="' + ln + '">' + ln + '</td><td>' + escaped + '</td></tr>' + mutantRows;`
        }
      }).join("");

      document.getElementById("l4-minimap").innerHTML = renderMinimap(file);

      const fileFindings = REPORT.findings.filter(f => f.location.file === file.path);
      const list = fileFindings.length ? fileFindings : REPORT.findings;
      const activeFinding = list.find(f => f.id === selectedFindingId) || list[0];

      document.getElementById("l4-findings").innerHTML = list.map(f =>
        '<div class="finding-card' + (activeFinding && activeFinding.id === f.id ? ' active' : '') + '" onclick="renderLevel4(\\'' + f.location.file + '\\', \\'' + f.id + '\\')">' +
          '<div class="fc-head">' + stateChip(f.state) + findingTitle(f) + '</div>' +
          '<div style="font-size:12px;margin-top:4px">' + f.reason + '</div>' +
          '<button class="copy-agent-btn" onclick="copyAgentTask(\\'' + f.id + '\\', this, event)">Copy as task for agent</button>' +
        '</div>'
      ).join("");

      renderFindingDetail(activeFinding);
      if (selectedFindingId && activeFinding && activeFinding.id === selectedFindingId && activeFinding.location.file === file.path) {
        jumpToLine(activeFinding.location.startLine);
      }
    }

    function escAttr(raw) {
      return String(raw).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    function findingTitle(f) {
      const full = "[" + f.id + "] " + f.title;
      return '<strong class="fc-title" title="' + escAttr(full) + '">' + escAttr(full) + '</strong>';
    }

    function renderMinimap(file) {
      const total = (file.lines || []).length || 1;
      const fmt = n => String(Number(n.toFixed(3)));
      const marks = [];
      let runState = null;
      let runStart = 1;
      for (let ln = 1; ln <= total + 1; ln++) {
        const raw = ln <= total ? (file.lineStates && file.lineStates[ln]) || null : null;
        const st = raw === "verified" ? null : raw;
        if (st !== runState) {
          if (runState) {
            const end = ln - 1;
            marks.push('<i class="mm-mark mm-' + runState + '" style="top:' + fmt((runStart - 1) / total * 100) + '%;height:' + fmt((end - runStart + 1) / total * 100) + '%" onclick="jumpToLine(' + runStart + ')" title="Lines ' + runStart + '-' + end + ' · ' + runState + '"></i>');
          }
          runState = st;
          runStart = ln;
        }
      }
      return marks.join("");
    }

    function jumpToLine(ln) {
      const el = document.querySelector('[data-ln="' + ln + '"]');
      if (el && el.scrollIntoView) el.scrollIntoView({ block: "center", behavior: "smooth" });
    }

    initViews();
  </script>
</body>
</html>`;
}

export async function writeHtmlFogMap(
  rootDir: string,
  report: CodefogReport,
  customHtmlPath?: string,
): Promise<string> {
  const outPath = customHtmlPath
    ? path.resolve(rootDir, customHtmlPath)
    : path.join(rootDir, ".codefog", "report.html");
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, renderHtmlFogMap(report), "utf8");
  return outPath;
}
