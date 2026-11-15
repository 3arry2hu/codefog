import * as path from "node:path";
import { STATE_URGENCY_ORDER } from "./scoring.js";
import type { CodefogReport, EvidenceState, LocByState } from "./types.js";

export const TERMINAL_MAX_COLUMNS = 100;
export const STATE_BAR_WIDTH = 40;

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

/** ANSI 16-color foreground per state; verified is deliberately the quietest. */
const STATE_ANSI: Record<EvidenceState, string> = {
  "fog-returned": "\x1b[1;33m",
  fog: "\x1b[1;34m",
  "self-proof-fog": "\x1b[36m",
  "weak-evidence": "\x1b[37m",
  verified: "\x1b[90m",
};

/** Glyph density falls as evidence gets stronger, so the bar still reads without color. */
export const STATE_BAR_GLYPHS: Record<EvidenceState, string> = {
  "fog-returned": "█",
  fog: "▓",
  "self-proof-fog": "▒",
  "weak-evidence": "░",
  verified: "·",
};

const STATE_SHORT_LABELS: Record<EvidenceState, string> = {
  "fog-returned": "Returned",
  fog: "Fog",
  "self-proof-fog": "Self-proof",
  "weak-evidence": "Weak",
  verified: "Verified",
};

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

function visibleLength(text: string): number {
  return [...stripAnsi(text)].length;
}

function paint(code: string, text: string): string {
  return `${code}${text}${RESET}`;
}

function padEnd(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleLength(text)));
}

function padStart(text: string, width: number): string {
  return " ".repeat(Math.max(0, width - visibleLength(text))) + text;
}

export function truncateMiddle(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  if (max <= 1) return "…";
  const head = Math.ceil((max - 1) / 2);
  const tail = max - 1 - head;
  return chars.slice(0, head).join("") + "…" + (tail > 0 ? chars.slice(-tail).join("") : "");
}

function truncateEnd(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  if (max <= 1) return "…";
  return chars.slice(0, max - 1).join("") + "…";
}

/** Cells per state by largest remainder; any state with LOC keeps at least one cell. */
export function stateBarCells(loc: LocByState, width = STATE_BAR_WIDTH): Record<EvidenceState, number> {
  const cells = { "fog-returned": 0, fog: 0, "self-proof-fog": 0, "weak-evidence": 0, verified: 0 };
  const total = STATE_URGENCY_ORDER.reduce((sum, s) => sum + loc[s], 0);
  if (total <= 0) return cells;
  const exact = STATE_URGENCY_ORDER.map((s) => ({ s, v: (loc[s] / total) * width }));
  for (const { s, v } of exact) cells[s] = Math.floor(v);
  let left = width - STATE_URGENCY_ORDER.reduce((sum, s) => sum + cells[s], 0);
  for (const { s } of [...exact].sort((a, b) => (b.v % 1) - (a.v % 1))) {
    if (left <= 0) break;
    cells[s] += 1;
    left -= 1;
  }
  for (const s of STATE_URGENCY_ORDER) {
    if (loc[s] > 0 && cells[s] === 0) {
      const donor = STATE_URGENCY_ORDER.reduce((a, b) => (cells[b] > cells[a] ? b : a));
      cells[donor] -= 1;
      cells[s] = 1;
    }
  }
  return cells;
}

function stateBar(loc: LocByState): string {
  const cells = stateBarCells(loc);
  const bar = STATE_URGENCY_ORDER.filter((s) => cells[s] > 0)
    .map((s) => paint(STATE_ANSI[s], STATE_BAR_GLYPHS[s].repeat(cells[s])))
    .join("");
  return bar || paint(DIM, "·".repeat(STATE_BAR_WIDTH));
}

/** Fog Returned anywhere dominates; otherwise the state holding the most LOC. */
function scoreState(loc: LocByState): EvidenceState {
  if (loc["fog-returned"] > 0) return "fog-returned";
  return STATE_URGENCY_ORDER.reduce((a, b) => (loc[b] > loc[a] ? b : a));
}

function stateName(state: EvidenceState, width = 0): string {
  return paint(STATE_ANSI[state], padEnd(state, width));
}

function stateCounts(counts: Partial<Record<EvidenceState, number>>, states: EvidenceState[]): string {
  return states
    .map((s) => `${paint(STATE_ANSI[s], STATE_BAR_GLYPHS[s])} ${STATE_SHORT_LABELS[s]} ${counts[s] ?? 0}`)
    .join("  ");
}

function label(text: string): string {
  return paint(DIM, padEnd(text, 11));
}

export function formatLevel1SummaryColor(
  report: CodefogReport,
  reportPath?: string,
  cwd: string = process.cwd(),
): string {
  const { summary, repository, modules, findings } = report;
  const m = summary.metrics;
  const coverage = m.coverageAvailable !== false;
  const mutation = m.mutationAvailable !== false;
  const na = paint(DIM, "—");
  const unverifiedLoc = summary.totalLoc - summary.locByState.verified;
  const fogPct = summary.totalLoc > 0 ? Math.round((unverifiedLoc / summary.totalLoc) * 100) : 0;

  const repoSuffix = ` (${repository.branch} @ ${repository.commit})`;
  const repoName = truncateMiddle(repository.name, TERMINAL_MAX_COLUMNS - 10 - [...repoSuffix].length);
  const trustState = scoreState(summary.locByState);

  const lines: string[] = [
    `${BOLD}codefog${RESET} · ${BOLD}${repoName}${RESET}${paint(DIM, truncateEnd(repoSuffix, TERMINAL_MAX_COLUMNS - 10 - [...repoName].length))}`,
    "",
    `${label("Trust")}${paint(STATE_ANSI[trustState], padStart(String(summary.trustScore), 3))}/100  ${stateBar(summary.locByState)}`,
    ...(summary.docTrustScore !== undefined && summary.docClaimsByState
      ? [
          `${label("Doc Trust")}${paint(STATE_ANSI[scoreState(summary.docClaimsByState)], padStart(String(summary.docTrustScore), 3))}/100  ${stateBar(summary.docClaimsByState)}`,
        ]
      : []),
    `${label("Scope")}${summary.totalFiles} files · ${summary.totalLoc} LOC · ${fogPct}% unverified`,
    `${label("States")}${stateCounts(summary.locByState, STATE_URGENCY_ORDER)}`,
    `${label("Metrics")}Line ${coverage ? `${m.lineCoveragePct}%` : na}  Branch ${coverage ? `${m.branchCoveragePct}%` : na}  Checked ${coverage ? `${m.checkedCoveragePct}%` : na}  Mutation ${mutation ? `${m.mutationScorePct}%` : na}`,
    `${label("")}Pseudo-tested ${coverage ? m.pseudoTestedMethods : na}  Contested ${m.contestedOracles}`,
    ...(summary.docClaimsByState
      ? [
          `${label("Doc Claims")}${summary.totalDocClaims ?? 0} total  ${stateCounts(summary.docClaimsByState, ["fog-returned", "fog", "weak-evidence", "verified"])}`,
        ]
      : []),
  ];

  if (modules.length > 0) {
    lines.push("", `${BOLD}Modules by Fog${RESET}`);
    const pathWidth = Math.min(24, Math.max(...modules.map((mod) => [...mod.path].length)));
    for (const mod of modules) {
      const st = scoreState(mod.locByState);
      lines.push(
        `  ${padEnd(truncateMiddle(mod.path, pathWidth), pathWidth)}  Trust ${paint(STATE_ANSI[st], padStart(String(mod.trustScore), 3))}/100  Risk ${padStart(String(mod.maxRiskScore), 4)}  ${stateCounts(mod.locByState, ["fog", "weak-evidence", "verified"])}`,
      );
    }
  }

  if (findings.length > 0) {
    lines.push("", `${BOLD}Top Findings${RESET}`);
    const top = findings.slice(0, 5);
    const idWidth = Math.max(...top.map((f) => f.id.length));
    const locs = top.map((f) => `${f.location.file}:${f.location.startLine}-${f.location.endLine}`);
    const locWidth = Math.min(36, Math.max(...locs.map((l) => [...l].length)));
    const stateWidth = Math.max(...top.map((f) => f.state.length));
    const riskWidth = Math.max(...top.map((f) => String(f.riskScore).length));
    top.forEach((f, i) => {
      const prefix = `  ${padEnd(f.id, idWidth)}  ${padEnd(truncateMiddle(locs[i]!, locWidth), locWidth)}  ${stateName(f.state, stateWidth)}  ${padStart(String(f.riskScore), riskWidth)}  `;
      lines.push(prefix + truncateEnd(f.title, Math.max(1, TERMINAL_MAX_COLUMNS - visibleLength(prefix))));
    });
  }

  if (reportPath) {
    const rel = path.relative(cwd, reportPath);
    const shown = rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : reportPath;
    lines.push("", `${label("Fog Map")}${truncateMiddle(shown, TERMINAL_MAX_COLUMNS - 11)}`);
  }

  return lines.map((line) => fitLine(line)).join("\n") + "\n";
}

/** Last-resort guard: lines are laid out to fit, but a pathological name must not wrap. */
function fitLine(line: string): string {
  if (visibleLength(line) <= TERMINAL_MAX_COLUMNS) return line;
  let out = "";
  let cols = 0;
  for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith("\x1b[")) {
      out += part;
      continue;
    }
    for (const ch of part) {
      if (cols >= TERMINAL_MAX_COLUMNS - 1) return out + "…" + RESET;
      out += ch;
      cols += 1;
    }
  }
  return out;
}

/** Color only when stdout is a terminal and NO_COLOR (https://no-color.org) is unset or empty. */
export function shouldUseColor(isTTY: boolean | undefined, env: NodeJS.ProcessEnv): boolean {
  return Boolean(isTTY) && !env.NO_COLOR;
}
