import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CODEFOG_COMMAND } from "./cli-command.js";
import { STATE_COLORS, STATE_URGENCY_ORDER } from "./scoring.js";
import { squarify, type TreemapRect } from "./treemap.js";
import type {
  ArchitectureSummary,
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
    ...(report.external
      ? [{ key: "external-issues", label: "External Issues", value: String(report.external.issues.length) }]
      : []),
    ...(report.libyear
      ? [{ key: "libyear", label: "Dependency Drift", value: `${report.libyear.totalLibyears} libyears` }]
      : []),
    ...(report.architecture
      ? [
          {
            key: "boundary-violations",
            label: "Boundary Violations",
            value: String(report.architecture.boundaryViolations.filter((violation) => !violation.baselined).length),
          },
          {
            key: "propagation-cost",
            label: "Propagation Cost",
            value: `${report.architecture.propagationCostPct}%`,
          },
        ]
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

function renderArchitecturePanel(architecture: ArchitectureSummary, findings: Finding[]): string {
  const findingsByFile = new Map<string, Finding[]>();
  for (const finding of findings) {
    const { file } = finding.location;
    const matches = findingsByFile.get(file);
    if (matches) matches.push(finding);
    else findingsByFile.set(file, [finding]);
  }

  function sourceButton(file: string, tag?: string, reason?: string): string {
    const finding = tag === undefined ? undefined : findingsByFile.get(file)?.find(
      (item) => item.tags?.includes(tag) && (reason === undefined || item.reason === reason),
    );
    return `<button type="button" class="architecture-source" data-file="${escapeAttrServer(file)}" data-finding="${escapeAttrServer(finding?.id ?? "")}" onclick="openArchitectureSource(this)">${escapeHtmlServer(file)}</button>`;
  }

  function group(title: string, items: string[]): string {
    return `<div class="architecture-group"><h3>${title}</h3>` +
      (items.length ? `<ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul>` : '<p class="architecture-empty">None detected.</p>') +
      '</div>';
  }

  const violations = architecture.boundaryViolations
    .filter((violation) => !violation.baselined)
    .map((violation) =>
      `<strong>${escapeHtmlServer(violation.from)} → ${escapeHtmlServer(violation.to)}</strong>` +
      `<div>${escapeHtmlServer(violation.explanation ?? violation.reason)}</div>` +
      sourceButton(violation.file, "boundary-violation", violation.reason),
    );
  const cycles = architecture.cycles.map((cycle) =>
    `<strong>${cycle.modules.map(escapeHtmlServer).join(", ")}</strong>` +
    `<div>${cycle.edges.map((edge) => `${escapeHtmlServer(edge.from)} → ${escapeHtmlServer(edge.to)}`).join(" · ")}</div>` +
    sourceButton(cycle.file, "arch-cycle"),
  );
  const hubs = architecture.unstableHubs.map((hub) =>
    sourceButton(hub.file, "unstable-hub") +
    `<div>Fan-in ${hub.fanIn} · Changes (90d) ${hub.churn90d} · Trust ${hub.trustScore}/100${hub.hasFogReturned ? " · Fog returned" : ""}</div>`,
  );
  const couplings = architecture.implicitCouplings.map((coupling) =>
    sourceButton(coupling.from) + " ↔ " + sourceButton(coupling.to) +
    `<div>${coupling.coChange} shared commits · ${fmtNum(coupling.coupling * 100, 1)}% coupling</div>`,
  );

  return '<div class="panel"><h2>Architecture Health</h2><div class="architecture-grid">' +
    group("Boundary Violations", violations) +
    group("Module Cycles", cycles) +
    group("Unstable Hubs", hubs) +
    group("Implicit Coupling", couplings) +
    '</div></div>';
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
  const architectureFindings = report.findings.filter((finding) => finding.subjectType === "architecture");
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
      color-scheme: light dark;
      --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif;
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      --sticky-offset: 88px;
      --bg-canvas: #F8FAFC;
      --bg-card: #FFFFFF;
      --bg-subtle: #F1F5F9;
      --border-subtle: #E2E8F0;
      --border-strong: #CBD5E1;
      --text-primary: #0F172A;
      --text-secondary: #475569;
      --text-muted: #64748B;
      --header-bg: #0F172A;
      --header-text: #F8FAFC;
      --header-muted: #CBD5E1;
      --header-pill: #1E293B;
      --swatch-ring: rgba(255, 255, 255, 0.5);
      --tile-label-bg: rgba(255, 255, 255, 0.9);
      /* Five-state scale (ADR-0001): Verified recedes into the canvas, Fog Returned is the only saturated hue */
      --state-verified: ${STATE_COLORS.verified};
      --state-weak: ${STATE_COLORS["weak-evidence"]};
      --state-self-proof: ${STATE_COLORS["self-proof-fog"]};
      --state-self-proof-hatch: #587294;
      --state-fog: ${STATE_COLORS.fog};
      --state-returned: ${STATE_COLORS["fog-returned"]};
      --on-returned: #FFFFFF;
      --on-fog: #FFFFFF;
      --on-self-proof: #FFFFFF;
      --tint-returned: rgba(189, 73, 0, 0.08);
      --tint-line-returned: rgba(189, 73, 0, 0.16);
      --tint-line-fog: rgba(29, 54, 86, 0.14);
      --tint-line-self-proof: rgba(110, 136, 170, 0.10);
      --tint-line-weak: rgba(188, 204, 226, 0.16);
      --mutant-bg: #FFF7ED;
      --mutant-text: #9A3412;
    }
    @media (prefers-color-scheme: dark) {
      /* ADR-0006: the lightness ladder inverts so Fog is brightest and Verified sits next to the canvas */
      :root {
        --bg-canvas: #0E1A2B;
        --bg-card: #112036;
        --bg-subtle: #172A44;
        --border-subtle: #1F3352;
        --border-strong: #2E4669;
        --text-primary: #E6ECF4;
        --text-secondary: #A9B8CC;
        --text-muted: #7D8FA8;
        --header-bg: #08111E;
        --header-text: #F2F5FA;
        --header-muted: #A9B8CC;
        --header-pill: #172A44;
        --swatch-ring: rgba(255, 255, 255, 0.25);
        --tile-label-bg: rgba(14, 26, 43, 0.88);
        --state-verified: #15243A;
        --state-weak: #2F4868;
        --state-self-proof: #6E88AA;
        --state-self-proof-hatch: #89A0BE;
        --state-fog: #C3D0E0;
        --state-returned: #FF8A3D;
        --on-returned: #0E1A2B;
        --on-fog: #0E1A2B;
        --on-self-proof: #0E1A2B;
        --tint-returned: rgba(255, 138, 61, 0.10);
        --tint-line-returned: rgba(255, 138, 61, 0.16);
        --tint-line-fog: rgba(195, 208, 224, 0.13);
        --tint-line-self-proof: rgba(110, 136, 170, 0.14);
        --tint-line-weak: rgba(47, 72, 104, 0.28);
        --mutant-bg: rgba(255, 138, 61, 0.12);
        --mutant-text: #FFB27A;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: var(--font-sans);
      font-variant-numeric: tabular-nums;
      background: var(--bg-canvas);
      color: var(--text-primary);
      line-height: 1.5;
    }
    .ls-label, .metric-label, .kpi-label {
      font: 700 10.5px/1.4 var(--font-mono);
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--text-muted);
    }
    header {
      background: var(--header-bg);
      color: var(--header-text);
      padding: 14px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 10px 24px;
      border-bottom: 1px solid var(--header-pill);
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
      background: var(--header-pill);
      color: var(--header-muted);
      padding: 3px 10px;
      border-radius: 999px;
      font-family: var(--font-mono);
      font-size: 12px;
    }
    .legend {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px 14px;
      font: 700 10.5px/1.4 var(--font-mono);
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--header-muted);
    }
    .swatch {
      display: inline-block;
      width: 12px;
      height: 12px;
      border-radius: 3px;
      vertical-align: middle;
      margin-right: 5px;
      box-shadow: 0 0 0 1px var(--swatch-ring);
    }
    .swatch-verified { background: var(--state-verified); }
    .swatch-weak { background: var(--state-weak); }
    .swatch-self-proof {
      background: repeating-linear-gradient(-45deg, var(--state-self-proof) 0 3px, var(--state-self-proof-hatch) 3px 6px);
    }
    .swatch-fog { background: var(--state-fog); }
    .swatch-returned { background: var(--state-returned); }
    .badge-returned {
      display: inline-block;
      background: var(--state-returned);
      color: var(--on-returned);
      font: 700 10px/1.5 var(--font-mono);
      padding: 0 6px;
      border-radius: 4px;
      letter-spacing: 0.08em;
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
      background: var(--bg-subtle);
      border: 1px solid var(--border-strong);
      color: var(--text-primary);
      padding: 6px 14px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }
    .nav-btn.active {
      background: var(--state-fog);
      color: var(--on-fog);
      border-color: var(--state-fog);
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
    .metric-val { font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }
    .metric-na .metric-val { color: var(--text-muted); font-weight: 400; }
    .metric-na { cursor: help; }
    .report-warning {
      background: var(--tint-returned);
      border: 1px solid var(--state-returned);
      border-radius: 8px;
      padding: 10px 14px;
      margin-bottom: 12px;
      font-size: 13px;
      white-space: pre-wrap;
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
    .module-row:hover { border-color: var(--state-self-proof); }
    .module-head { display: flex; justify-content: space-between; gap: 12px; font-weight: 600; }
    .module-path { font-family: var(--font-mono); font-size: 13px; }
    .module-meta { font-size: 12px; font-weight: 400; color: var(--text-secondary); font-family: inherit; }
    .module-states { font-size: 12px; color: var(--text-muted); margin-top: 4px; }
    .architecture-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .architecture-group {
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      padding: 12px;
      overflow-wrap: anywhere;
    }
    .architecture-group h3 { margin: 0; font-size: 13px; }
    .architecture-group ul { list-style: none; margin: 4px 0 0; padding: 0; }
    .architecture-group li { padding: 8px 0 0; font-size: 12px; color: var(--text-secondary); }
    .architecture-group li + li { border-top: 1px solid var(--border-subtle); margin-top: 8px; }
    .architecture-empty { margin: 6px 0 0; color: var(--text-muted); font-size: 12px; }
    .architecture-source {
      padding: 0;
      border: 0;
      background: none;
      color: var(--text-primary);
      font: inherit;
      font-family: var(--font-mono);
      text-decoration: underline;
      text-align: left;
      cursor: pointer;
      overflow-wrap: anywhere;
    }
    .state-chip {
      display: inline-block;
      flex: none;
      min-width: 74px;
      text-align: center;
      font: 700 10px/1.6 var(--font-mono);
      letter-spacing: 0.08em;
      padding: 0 6px;
      border-radius: 4px;
      border: 1px solid transparent;
    }
    .chip-fog-returned { background: var(--state-returned); color: var(--on-returned); }
    .chip-fog { background: var(--state-fog); color: var(--on-fog); }
    .chip-self-proof-fog {
      background: repeating-linear-gradient(-45deg, var(--state-self-proof) 0 3px, var(--state-self-proof-hatch) 3px 6px);
      color: var(--on-self-proof);
    }
    .chip-weak-evidence { background: var(--state-weak); color: var(--text-primary); }
    .chip-verified { background: var(--state-verified); color: var(--text-secondary); border-color: var(--border-subtle); }
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
    .tf-symbol { font-family: var(--font-mono); font-size: 13px; font-weight: 600; }
    .tf-loc { font-size: 11px; color: var(--text-muted); font-family: var(--font-mono); }
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
      background: var(--state-verified);
      margin-top: 8px;
    }
    .bar-seg-returned { background: var(--state-returned); }
    .bar-seg-fog { background: var(--state-fog); }
    .bar-seg-self-proof {
      background: repeating-linear-gradient(-45deg, var(--state-self-proof) 0 4px, var(--state-self-proof-hatch) 4px 8px);
    }
    .bar-seg-weak { background: var(--state-weak); }
    .bar-seg-verified { background: var(--state-verified); }
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
    .seg-fog-returned { background: var(--state-returned); }
    .seg-fog { background: var(--state-fog); }
    .seg-self-proof-fog {
      background: repeating-linear-gradient(-45deg, var(--state-self-proof) 0 4px, var(--state-self-proof-hatch) 4px 8px);
    }
    .seg-weak-evidence { background: var(--state-weak); }
    .seg-verified { background: var(--state-verified); }
    .tm-label {
      position: absolute;
      left: 5px;
      top: 5px;
      max-width: calc(100% - 10px);
      background: var(--tile-label-bg);
      color: var(--text-primary);
      border-radius: 4px;
      padding: 2px 6px;
      font-size: 11px;
      line-height: 1.35;
    }
    .tm-label strong {
      display: block;
      font-family: var(--font-mono);
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
      font: 700 11px var(--font-mono);
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
      font-family: var(--font-mono);
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
      background: repeating-linear-gradient(-45deg, var(--state-self-proof) 0 2px, var(--state-self-proof-hatch) 2px 4px) right / 4px 100% no-repeat;
    }
    .line-fog-returned > td:not(.ln-col) { background: var(--tint-line-returned); }
    .line-fog > td:not(.ln-col) { background: var(--tint-line-fog); }
    .line-self-proof-fog > td:not(.ln-col) { background: var(--tint-line-self-proof); }
    .line-weak-evidence > td:not(.ln-col) { background: var(--tint-line-weak); }
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
    .mm-self-proof-fog { background: repeating-linear-gradient(-45deg, var(--state-self-proof) 0 2px, var(--state-self-proof-hatch) 2px 4px); }
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
      background: var(--mutant-bg);
      color: var(--mutant-text);
      border-left: 4px solid var(--state-returned);
      font-size: 11px;
      padding: 4px 12px;
    }
    .finding-card {
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 12px;
      background: var(--bg-canvas);
      cursor: pointer;
    }
    .finding-card.active {
      border-color: var(--state-fog);
      box-shadow: 0 0 0 1px var(--state-fog);
    }
    .structure-evidence { margin-top: 6px; font-size: 12px; overflow-wrap: anywhere; }
    .structure-region { display: block; width: 100%; text-align: left; color: var(--text-primary); font: inherit; font-size: 12px; overflow-wrap: anywhere; }
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
      .architecture-grid { grid-template-columns: minmax(0, 1fr); }
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
          <div id="l1-findings">${renderTopFindingsServer(report.findings.filter((finding) => finding.subjectType !== "architecture"))}</div>
        </div>
      </div>
    </section>

    <!-- Level 2: Module Drilldown -->
    <section id="view-level-2" class="level-section hidden">
      <div class="panel">
        <h2>Module Breakdown <span class="panel-sub">${verifiedCollapsedTotal} verified files collapsed</span></h2>
        <div id="l2-submodules">${serverModulesHtml}</div>
      </div>
      ${report.architecture ? renderArchitecturePanel(report.architecture, architectureFindings) : ""}
    </section>

    <!-- Level 3: File Map Treemap -->
    <section id="view-level-3" class="level-section hidden">${renderLevel3Server(report, hasDocs)}
    </section>

    <!-- Level 4: Three-Column Source & Evidence View -->
    <section id="view-level-4" class="level-section hidden">
      <div class="grid-3col">
        <!-- Left Column: Findings List -->
        <div class="panel l4-side">
          <h2 id="l4-list-title">Findings List</h2>
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
    ${report.architecture ? `
    function openArchitectureSource(button) {
      const { file, finding } = button.dataset;
      switchLevel(4, file, finding);
      if (!finding) jumpToLine(1);
    }
    ` : ""}

    function buildFindingMarkdown(f) {
      const isArchitecture = f.subjectType === "architecture";
      return [
        "### Codefog Finding [" + f.id + "]: " + f.title + (isArchitecture ? "" : " (" + f.state + ")"),
        "- **Location**: " + f.location.file + ":" + f.location.startLine + "-" + f.location.endLine + " (" + f.location.symbol + ")",
        ...(isArchitecture ? [] : ["- **Risk Score**: " + f.riskScore + "/10"]),
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

    function renderStructureEvidence(evidence) {
      const metrics = [];
      if (evidence.cognitiveComplexity !== undefined) {
        metrics.push('<div><strong>Cognitive Complexity:</strong> ' + evidence.cognitiveComplexity + '</div>');
      }
      if (evidence.maxNestingDepth !== undefined) {
        metrics.push('<div><strong>Max Nesting Depth:</strong> ' + evidence.maxNestingDepth + '</div>');
      }
      if (evidence.errorMaskingLines && evidence.errorMaskingLines.length) {
        metrics.push('<div><strong>Error masking lines:</strong> ' + evidence.errorMaskingLines.map(line =>
          '<button type="button" class="architecture-source" onclick="jumpToLine(' + Number(line) + ')">' + escAttr(line) + '</button>'
        ).join(', ') + '</div>');
      }
      return metrics.length ? '<div class="structure-evidence">' + metrics.join('') + '</div>' : '';
    }

    function renderFindingDetail(f, region) {
      const detailEl = document.getElementById("l4-finding-detail");
      if (region) {
        detailEl.innerHTML = '<div class="finding-card active">' +
          '<strong>' + escAttr(region.symbol) + '</strong>' +
          renderStructureEvidence(region) + '</div>';
        return;
      }
      if (!f) {
        detailEl.innerHTML = '<div style="font-size:13px;color:var(--text-muted)">Select a finding to inspect evidence & agent remediation instructions.</div>';
        return;
      }
      if (f.subjectType === "architecture") {
        detailEl.innerHTML = '<div class="finding-card active">' +
          '<div class="fc-head">' + findingTitle(f) + '</div>' +
          '<div class="structure-evidence">' + escAttr(f.reason) + '</div>' +
          '<div class="structure-evidence"><strong>Suggested Action:</strong> ' + escAttr(f.suggestedAction) + '</div></div>';
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
          '<div style="font-size:12px;margin-top:6px"><strong>Location:</strong> ' + escAttr(f.location.file) + ':' + f.location.startLine + '-' + f.location.endLine + '</div>' +${
            hasDocs
              ? `
          claimRefHtml +`
              : ""
          }
          '<div style="font-size:12px;margin-top:4px"><strong>Risk Score:</strong> ' + f.riskScore + '/10</div>' +
          '<div style="font-size:12px;margin-top:4px"><strong>Why it is in fog:</strong> ' + escAttr(f.reason) + '</div>' +
          '<div style="font-size:12px;margin-top:4px"><strong>Evidence:</strong> Executed by ' + f.evidence.executedByTests + ' test(s), ' + f.evidence.assertionsOnOutcome + ' outcome assertion(s)' + (f.evidence.pseudoTested ? ' [PSEUDO-TESTED]' : '') + '</div>' +
          renderStructureEvidence(f.evidence) +
          ((f.tags || []).includes("dead-code-fog") ? '<div class="structure-evidence"><code>dead-code-fog</code></div>' : '') +
          (mutantsHtml ? '<ul style="font-size:12px;margin:6px 0;padding-left:18px">' + mutantsHtml + '</ul>' : '') +${
            hasExternal || hasDocs
              ? `
          (externalHtml ? '<div style="font-size:12px;margin-top:4px"><strong>External Overlay:</strong><ul style="font-size:12px;margin:4px 0;padding-left:18px">' + externalHtml + '</ul></div>' : '') +`
              : ""
          }
          '<div style="font-size:12px;margin-top:6px"><strong>Suggested Action:</strong> ' + escAttr(f.suggestedAction) + '</div>' +
          '<div style="font-size:11px;margin-top:6px;font-family:var(--font-mono);background:var(--bg-subtle);padding:6px;border-radius:4px">' + escAttr(f.acceptanceCheck.command) + '</div>' +
          '<button class="copy-agent-btn" onclick="copyAgentTask(\\'' + f.id + '\\', this, event)">Copy as task for agent</button>' +
        '</div>';
    }

    function renderLevel4(filePath, selectedFindingId, selectedRegionIndex) {
      const architectureSources = REPORT.architecture?.sourceFiles;
      const architecturePath = filePath || Object.keys(architectureSources || {})[0];
      const architectureLines = architectureSources && Object.hasOwn(architectureSources, architecturePath)
        ? architectureSources[architecturePath]
        : undefined;${
      hasDocs ? `
      const docFile = (REPORT.docFiles || []).find(df => df.path === filePath);` : ""
    }
      const file = ${hasDocs ? "docFile || " : ""}REPORT.files.find(f => f.path === filePath) ||
        (architectureLines && { path: architecturePath, lines: architectureLines }) ||
        ${hasDocs ? "(REPORT.docFiles && REPORT.docFiles[0]) || " : ""}REPORT.files[0];
      if (!file) return;
      document.getElementById("l4-file-title").textContent = file.trustScore === undefined
        ? file.path
        : file.path + " (Trust " + file.trustScore + "/100)";

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
      const regionEntries = (file.regions || []).map((region, index) => ({ region, index }))
        .filter(({ region }) => region.cognitiveComplexity !== undefined && !region.findingId);
      const list = fileFindings.length || regionEntries.length ? fileFindings : REPORT.findings;
      const activeRegion = regionEntries.find(entry => entry.index === selectedRegionIndex) ||
        (list.length === 0 ? regionEntries[0] : undefined);
      const activeFinding = activeRegion ? undefined : list.find(f => f.id === selectedFindingId) || list[0];
      document.getElementById("l4-list-title").textContent = regionEntries.length ? "Findings and Functions" : "Findings List";

      const findingCards = list.map(f =>
        '<div class="finding-card' + (activeFinding && activeFinding.id === f.id ? ' active' : '') + '" data-file="' + escAttr(f.location.file) + '" data-finding="' + escAttr(f.id) + '" onclick="renderLevel4(this.dataset.file, this.dataset.finding)">' +
          '<div class="fc-head">' + (f.subjectType === "architecture" ? '' : stateChip(f.state)) + findingTitle(f) + '</div>' +
          '<div style="font-size:12px;margin-top:4px">' + escAttr(f.reason) + '</div>' +
          '<button class="copy-agent-btn" onclick="copyAgentTask(this.parentElement.dataset.finding, this, event)">Copy as task for agent</button>' +
        '</div>'
      ).join("");
      const regionCards = regionEntries.map(({ region, index }) =>
        '<button type="button" class="finding-card structure-region' + (activeRegion && activeRegion.index === index ? ' active' : '') +
        '" data-file="' + escAttr(file.path) + '" data-region="' + index +
        '" onclick="renderLevel4(this.dataset.file, undefined, Number(this.dataset.region))">' +
          '<strong>' + escAttr(region.symbol) + '</strong> · Lines ' + region.startLine + '–' + region.endLine + '</button>'
      ).join("");
      document.getElementById("l4-findings").innerHTML = findingCards + regionCards;

      renderFindingDetail(activeFinding, activeRegion && activeRegion.region);
      if (selectedRegionIndex !== undefined && activeRegion) jumpToLine(activeRegion.region.startLine);
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
