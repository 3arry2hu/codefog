import * as fs from "node:fs/promises";
import * as path from "node:path";
import { STATE_COLORS } from "./scoring.js";
import type { CodefogReport } from "./types.js";

export function renderHtmlFogMap(report: CodefogReport): string {
  const safeJson = JSON.stringify(report).replace(/<\//g, "<\\/");
  const verifiedCollapsedTotal = report.modules.reduce(
    (acc, m) => acc + m.verifiedFilesCollapsed,
    0,
  );

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
      gap: 14px;
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
    }
    .swatch-verified { background: ${STATE_COLORS.verified}; border: 1px solid #CBD5E1; }
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
    .kpi-strip {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
      gap: 12px;
      margin-bottom: 20px;
    }
    .kpi-card {
      background: var(--bg-card);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      padding: 12px 16px;
    }
    .kpi-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
    }
    .kpi-val {
      font-size: 22px;
      font-weight: 700;
      margin-top: 2px;
    }
    .grid-2col {
      display: grid;
      grid-template-columns: 1.5fr 1fr;
      gap: 20px;
    }
    .grid-3col {
      display: grid;
      grid-template-columns: 300px 1fr 360px;
      gap: 16px;
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
    .treemap-wrap {
      display: grid;
      grid-template-columns: 1fr 220px;
      gap: 14px;
    }
    .treemap-tiles {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: stretch;
    }
    .tile {
      border-radius: 8px;
      padding: 12px;
      min-width: 140px;
      cursor: pointer;
      border: 1px solid rgba(15, 23, 42, 0.12);
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    .tile-fog-returned { background: ${STATE_COLORS["fog-returned"]}; color: #FFFFFF; }
    .tile-fog { background: ${STATE_COLORS.fog}; color: #FFFFFF; }
    .tile-self-proof-fog {
      background: repeating-linear-gradient(-45deg, ${STATE_COLORS["self-proof-fog"]}, ${STATE_COLORS["self-proof-fog"]} 6px, #5B7597 6px, #5B7597 12px);
      color: #FFFFFF;
    }
    .tile-weak-evidence { background: ${STATE_COLORS["weak-evidence"]}; color: #0F172A; }
    .tile-verified { background: ${STATE_COLORS.verified}; color: #475569; }
    .collapsed-zone {
      background: ${STATE_COLORS.verified};
      border: 1px dashed #94A3B8;
      border-radius: 8px;
      padding: 14px;
      color: #475569;
      font-size: 12px;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      text-align: center;
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
      width: 44px;
      text-align: right;
      color: #64748B;
      user-select: none;
      border-right: 1px solid #E2E8F0;
    }
    .line-fog-returned { background: rgba(189, 73, 0, 0.18); border-left: 4px solid ${STATE_COLORS["fog-returned"]}; }
    .line-fog { background: rgba(29, 54, 86, 0.16); border-left: 4px solid ${STATE_COLORS.fog}; }
    .line-self-proof-fog { background: rgba(110, 136, 170, 0.20); border-left: 4px solid ${STATE_COLORS["self-proof-fog"]}; }
    .line-weak-evidence { background: rgba(188, 204, 226, 0.32); border-left: 4px solid ${STATE_COLORS["weak-evidence"]}; }
    .line-verified { background: ${STATE_COLORS.verified}; border-left: 4px solid #CBD5E1; color: #475569; }
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
      background: #0F172A;
      color: #FFFFFF;
      border: none;
      border-radius: 6px;
      padding: 6px 12px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    .copy-agent-btn:hover { background: ${STATE_COLORS.fog}; }
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
      <span><i class="swatch swatch-returned"></i>Fog Returned (${STATE_COLORS["fog-returned"]} <span class="badge-returned">RETURNED</span>)</span>
      <span><i class="swatch swatch-fog"></i>Fog (${STATE_COLORS.fog})</span>
      <span><i class="swatch swatch-self-proof"></i>Self-proof Fog (${STATE_COLORS["self-proof-fog"]})</span>
      <span><i class="swatch swatch-weak"></i>Weak Evidence (${STATE_COLORS["weak-evidence"]})</span>
      <span><i class="swatch swatch-verified"></i>Verified (${STATE_COLORS.verified})</span>
    </div>
  </header>

  <nav class="nav-levels">
    <button class="nav-btn active" data-level="1" onclick="switchLevel(1)">Level 1: Repository</button>
    <button class="nav-btn" data-level="2" onclick="switchLevel(2)">Level 2: Module</button>
    <button class="nav-btn" data-level="3" onclick="switchLevel(3)">Level 3: File Map</button>
    <button class="nav-btn" data-level="4" onclick="switchLevel(4)">Level 4: Source & Evidence</button>
  </nav>

  <main>
    <section class="kpi-strip">
      <div class="kpi-card">
        <div class="kpi-label">Trust Score</div>
        <div class="kpi-val">${report.summary.trustScore}/100</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Line / Branch Coverage</div>
        <div class="kpi-val">${report.summary.metrics.lineCoveragePct}% / ${report.summary.metrics.branchCoveragePct}%</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Checked Coverage</div>
        <div class="kpi-val">${report.summary.metrics.checkedCoveragePct}%</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Mutation Score</div>
        <div class="kpi-val">${report.summary.metrics.mutationScorePct}%</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Pseudo-tested Methods</div>
        <div class="kpi-val">${report.summary.metrics.pseudoTestedMethods}</div>
      </div>
    </section>

    <!-- Level 1: Repository Overview -->
    <section id="view-level-1" class="level-section">
      <div class="grid-2col">
        <div class="panel">
          <h2>Modules by Fog</h2>
          <div id="l1-modules"></div>
        </div>
        <div class="panel">
          <h2>Top Fog Hotspots</h2>
          <div id="l1-hotspots"></div>
        </div>
      </div>
    </section>

    <!-- Level 2: Module Drilldown -->
    <section id="view-level-2" class="level-section hidden">
      <div class="panel">
        <h2>Module Breakdown <span style="font-size:12px;color:#64748B">${verifiedCollapsedTotal} verified files collapsed</span></h2>
        <div id="l2-submodules"></div>
      </div>
    </section>

    <!-- Level 3: File Map Treemap -->
    <section id="view-level-3" class="level-section hidden">
      <div class="panel">
        <h2>File Fog Map (2D Area-Proportional Treemap)</h2>
        <div class="treemap-wrap">
          <div id="l3-tiles" class="treemap-tiles"></div>
          <div class="collapsed-zone">
            <strong>${verifiedCollapsedTotal} verified files collapsed</strong>
            <span style="margin-top:4px">Muted ${STATE_COLORS.verified} background; zero action needed</span>
          </div>
        </div>
      </div>
    </section>

    <!-- Level 4: Three-Column Source & Evidence View -->
    <section id="view-level-4" class="level-section hidden">
      <div class="grid-3col">
        <!-- Left Column: Findings List -->
        <div class="panel">
          <h2>Findings List</h2>
          <div id="l4-findings"></div>
          ${
            report.findings.length === 0
              ? '<div class="finding-card">No active findings. Example command: <code>npx codefog verify --mutants</code> <button class="copy-agent-btn">Copy as task for agent</button></div>'
              : ""
          }
        </div>
        <!-- Center Column: Source Code & Inline Surviving Mutants -->
        <div class="panel">
          <h2 id="l4-file-title">Source View</h2>
          <table class="source-table" id="l4-source-table"></table>
        </div>
        <!-- Right Column: Selected Finding Detail & Copy as task for agent -->
        <div class="panel">
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

    function renderStackedBar(loc) {
      const total = (loc["fog-returned"] || 0) + (loc.fog || 0) + (loc["self-proof-fog"] || 0) + (loc["weak-evidence"] || 0) + (loc.verified || 0) || 1;
      const p = k => ((loc[k] || 0) / total * 100).toFixed(1) + "%";
      return '<div class="stacked-bar">' +
        '<div class="bar-seg-returned" style="width:' + p("fog-returned") + '"></div>' +
        '<div class="bar-seg-fog" style="width:' + p("fog") + '"></div>' +
        '<div class="bar-seg-self-proof" style="width:' + p("self-proof-fog") + '"></div>' +
        '<div class="bar-seg-weak" style="width:' + p("weak-evidence") + '"></div>' +
        '<div class="bar-seg-verified" style="width:' + p("verified") + '"></div>' +
      '</div>';
    }

    function initViews() {
      const l1Mod = document.getElementById("l1-modules");
      l1Mod.innerHTML = REPORT.modules.map(m =>
        '<div class="module-row" onclick="switchLevel(2)">' +
          '<div style="display:flex;justify-content:space-between;font-weight:600">' +
            '<span>' + m.path + ' (' + m.totalFiles + ' files, ' + m.verifiedFilesCollapsed + ' verified files collapsed)</span>' +
            '<span>Trust ' + m.trustScore + '/100 · Max Risk ' + m.maxRiskScore + '</span>' +
          '</div>' +
          renderStackedBar(m.locByState) +
        '</div>'
      ).join("");

      const l1Hot = document.getElementById("l1-hotspots");
      l1Hot.innerHTML = REPORT.findings.map(f =>
        '<div class="finding-card" onclick="switchLevel(4, \\'' + f.location.file + '\\', \\'' + f.id + '\\')">' +
          '<div style="display:flex;justify-content:space-between;align-items:center">' +
            '<strong>' + f.title + '</strong>' +
            (f.state === "fog-returned" ? '<span class="badge-returned">RETURNED</span>' : '<span>' + f.state + '</span>') +
          '</div>' +
          '<div style="font-size:12px;color:#475569;margin-top:4px">' + f.location.file + ':' + f.location.startLine + '-' + f.location.endLine + ' · Risk ' + f.riskScore + '</div>' +
          '<div style="font-size:12px;margin-top:4px">' + f.reason + '</div>' +
          '<div style="font-size:11px;margin-top:4px;font-family:monospace">' + f.acceptanceCheck.command + '</div>' +
          '<button class="copy-agent-btn" onclick="copyAgentTask(\\'' + f.id + '\\', this, event)">Copy as task for agent</button>' +
        '</div>'
      ).join("");

      document.getElementById("l2-submodules").innerHTML = l1Mod.innerHTML;

      // Area-proportional Treemap tiles: flex-grow and min-height scale with file.totalLoc
      const l3Tiles = document.getElementById("l3-tiles");
      l3Tiles.innerHTML = REPORT.files.map(file => {
        const locWeight = Math.max(1, file.totalLoc);
        const minH = Math.min(220, Math.max(76, 56 + locWeight * 8));
        return '<div class="tile tile-' + file.dominantState + '" style="flex:' + locWeight + ' 1 ' + Math.min(340, 140 + locWeight * 12) + 'px;min-height:' + minH + 'px" onclick="switchLevel(4, \\'' + file.path + '\\')">' +
          '<div style="display:flex;justify-content:space-between;align-items:center">' +
            '<strong>' + file.path + '</strong>' +
            (file.dominantState === "fog-returned" ? '<span class="badge-returned">RETURNED</span>' : '') +
          '</div>' +
          '<div style="font-size:12px;margin-top:6px">LOC: ' + file.totalLoc + ' · Unverified: ' + file.unverifiedLoc + ' · Risk: ' + file.riskScore + '</div>' +
        '</div>';
      }).join("");

      if (REPORT.files[0]) {
        renderLevel4(REPORT.files[0].path);
      }
    }

    function renderFindingDetail(f) {
      const detailEl = document.getElementById("l4-finding-detail");
      if (!f) {
        detailEl.innerHTML = '<div style="font-size:13px;color:#64748B">Select a finding to inspect evidence & agent remediation instructions.</div>';
        return;
      }
      const mutantsHtml = (f.evidence.survivingMutants || []).map(m =>
        '<li>Line ' + m.line + ': <code>' + m.original + '</code> → <code>' + m.mutated + '</code> (survived ' + m.testsRun + ' tests)</li>'
      ).join("");
      detailEl.innerHTML =
        '<div class="finding-card active">' +
          '<div style="display:flex;justify-content:space-between;align-items:center">' +
            '<strong>[' + f.id + '] ' + f.title + '</strong>' +
            (f.state === "fog-returned" ? '<span class="badge-returned">RETURNED</span>' : '<span>' + f.state + '</span>') +
          '</div>' +
          '<div style="font-size:12px;margin-top:6px"><strong>Location:</strong> ' + f.location.file + ':' + f.location.startLine + '-' + f.location.endLine + '</div>' +
          '<div style="font-size:12px;margin-top:4px"><strong>Risk Score:</strong> ' + f.riskScore + '/10</div>' +
          '<div style="font-size:12px;margin-top:4px"><strong>Why it is in fog:</strong> ' + f.reason + '</div>' +
          '<div style="font-size:12px;margin-top:4px"><strong>Evidence:</strong> Executed by ' + f.evidence.executedByTests + ' test(s), ' + f.evidence.assertionsOnOutcome + ' outcome assertion(s)' + (f.evidence.pseudoTested ? ' [PSEUDO-TESTED]' : '') + '</div>' +
          (mutantsHtml ? '<ul style="font-size:12px;margin:6px 0;padding-left:18px">' + mutantsHtml + '</ul>' : '') +
          '<div style="font-size:12px;margin-top:6px"><strong>Suggested Action:</strong> ' + f.suggestedAction + '</div>' +
          '<div style="font-size:11px;margin-top:6px;font-family:monospace;background:#E2E8F0;padding:6px;border-radius:4px">' + f.acceptanceCheck.command + '</div>' +
          '<button class="copy-agent-btn" onclick="copyAgentTask(\\'' + f.id + '\\', this, event)">Copy as task for agent</button>' +
        '</div>';
    }

    function renderLevel4(filePath, selectedFindingId) {
      const file = REPORT.files.find(f => f.path === filePath) || REPORT.files[0];
      if (!file) return;
      document.getElementById("l4-file-title").textContent = file.path + " (Trust " + file.trustScore + "/100)";

      // Build map of surviving mutants by line number for inline source annotation
      const mutantsByLine = {};
      (file.regions || []).forEach(r => {
        (r.survivingMutants || []).forEach(m => {
          mutantsByLine[m.line] = mutantsByLine[m.line] || [];
          mutantsByLine[m.line].push(m);
        });
      });

      const table = document.getElementById("l4-source-table");
      table.innerHTML = (file.lines || []).map((lineText, idx) => {
        const ln = idx + 1;
        const st = (file.lineStates && file.lineStates[ln]) || "verified";
        const escaped = lineText.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const lineMutants = mutantsByLine[ln] || [];
        const mutantRows = lineMutants.map(m =>
          '<tr class="mutant-inline-row"><td class="ln-col">↳</td><td>⚠️ Surviving Mutant [' + m.id + ']: <code>' + m.original + '</code> → <code>' + m.mutated + '</code> (survived ' + m.testsRun + ' tests)</td></tr>'
        ).join("");
        return '<tr class="line-' + st + '"><td class="ln-col">' + ln + '</td><td>' + escaped + '</td></tr>' + mutantRows;
      }).join("");

      const fileFindings = REPORT.findings.filter(f => f.location.file === file.path);
      const list = fileFindings.length ? fileFindings : REPORT.findings;
      const activeFinding = list.find(f => f.id === selectedFindingId) || list[0];

      document.getElementById("l4-findings").innerHTML = list.map(f =>
        '<div class="finding-card' + (activeFinding && activeFinding.id === f.id ? ' active' : '') + '" onclick="renderLevel4(\\'' + f.location.file + '\\', \\'' + f.id + '\\')">' +
          '<div><strong>[' + f.id + '] ' + f.title + '</strong> (' + f.state + ')</div>' +
          '<div style="font-size:12px;margin-top:4px">' + f.reason + '</div>' +
          '<button class="copy-agent-btn" onclick="copyAgentTask(\\'' + f.id + '\\', this, event)">Copy as task for agent</button>' +
        '</div>'
      ).join("");

      renderFindingDetail(activeFinding);
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
