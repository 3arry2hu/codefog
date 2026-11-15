import { describe, it, expect } from "vitest";
import * as vm from "node:vm";
import { renderHtmlFogMap } from "../src/html-report.js";
import type { CodefogReport, EvidenceState, Finding, FileSummary, LocByState } from "../src/types.js";

function loc(partial: Partial<LocByState>): LocByState {
  return { "fog-returned": 0, fog: 0, "self-proof-fog": 0, "weak-evidence": 0, verified: 0, ...partial };
}

// 100-line file: 1-10 verified, 11-30 fog, 31-40 weak, 41-50 self-proof, 51-60 fog-returned, 61-100 no state
function lineStates(): Record<number, EvidenceState> {
  const states: Record<number, EvidenceState> = {};
  const ranges: Array<[number, number, EvidenceState]> = [
    [1, 10, "verified"],
    [11, 30, "fog"],
    [31, 40, "weak-evidence"],
    [41, 50, "self-proof-fog"],
    [51, 60, "fog-returned"],
  ];
  for (const [a, b, s] of ranges) for (let i = a; i <= b; i++) states[i] = s;
  return states;
}

const LONG_TITLE = "renderVeryLongGeneratedSymbolNameThatOverflowsTheFindingsColumnInLevelFour";

function finding(id: string, title: string, startLine: number): Finding {
  return {
    id,
    title,
    state: "fog",
    riskScore: 7,
    agentReady: true,
    location: { file: "src/big.ts", symbol: title, startLine, endLine: startLine + 5 },
    reason: "no tests",
    evidence: {
      executedByTests: 0,
      assertionsOnOutcome: 0,
      pseudoTested: false,
      oracleContest: false,
      oracleIds: [],
      missedBoundary: false,
      survivingMutants: [],
    },
    suggestedAction: "add a test",
    acceptanceCheck: { command: "npx @barryzhu/codefog verify src/big.ts", criteria: [] },
  };
}

function report(): CodefogReport {
  const file: FileSummary = {
    path: "src/big.ts",
    modulePath: "src",
    totalLoc: 60,
    unverifiedLoc: 50,
    dominantState: "fog-returned",
    trustScore: 20,
    riskScore: 7,
    churn90d: 0,
    cyclomaticComplexity: 1,
    locByState: loc({ verified: 10, fog: 20, "weak-evidence": 10, "self-proof-fog": 10, "fog-returned": 10 }),
    lines: Array.from({ length: 100 }, (_, i) => `const line${i + 1} = ${i + 1};`),
    lineStates: lineStates(),
    regions: [],
  };
  return {
    $schema: "https://codefog.dev/schemas/v1/report.json",
    version: "1.0.0",
    repository: { name: "demo", branch: "main", commit: "abc1234", generatedAt: "2026-01-01T00:00:00.000Z" },
    summary: {
      trustScore: 20,
      totalFiles: 1,
      totalLoc: 60,
      metrics: {
        lineCoveragePct: 50,
        branchCoveragePct: 50,
        checkedCoveragePct: 50,
        mutationScorePct: 0,
        pseudoTestedMethods: 0,
        contestedOracles: 0,
      },
      locByState: file.locByState,
    },
    modules: [],
    findings: [finding("CF-0001", LONG_TITLE, 11), finding("CF-0002", "short", 31)],
    files: [file],
  };
}

interface FakeEl {
  innerHTML: string;
  textContent: string;
  scrolled: number;
  classList: { toggle(): void; add(): void; remove(): void };
  scrollIntoView(): void;
}

function runPage(html: string) {
  const script = /<script>([\s\S]*)<\/script>/.exec(html)![1];
  const els = new Map<string, FakeEl>();
  const scrolledTo: string[] = [];
  const make = (key: string): FakeEl => ({
    innerHTML: "",
    textContent: "",
    scrolled: 0,
    classList: { toggle() {}, add() {}, remove() {} },
    scrollIntoView() {
      scrolledTo.push(key);
    },
  });
  const document = {
    getElementById(id: string) {
      if (!els.has(id)) els.set(id, make(`#${id}`));
      return els.get(id)!;
    },
    querySelectorAll: () => [],
    querySelector: (sel: string) => make(sel),
  };
  const ctx = vm.createContext({ document, navigator: {}, setTimeout: () => 0 });
  vm.runInContext(script, ctx);
  return { els, ctx: ctx as Record<string, any>, scrolledTo };
}

describe("Ticket 39: Level 4 code view: verified recedes, gutter bars, minimap", () => {
  it("styles verified rows without background and gives every other state a gutter bar", () => {
    const html = renderHtmlFogMap(report());
    const css = /<style>([\s\S]*?)<\/style>/.exec(html)![1];
    const rules = (selector: string) =>
      [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
        .filter((m) => m[1].split(",").some((s) => s.trim().startsWith(selector)))
        .map((m) => m[2])
        .join(";");
    expect(rules(".line-verified")).not.toMatch(/background/);
    expect(rules(".line-verified")).not.toMatch(/border/);
    for (const [state, color] of [
      ["fog-returned", "--state-returned"],
      ["fog", "--state-fog"],
      ["weak-evidence", "--state-weak"],
    ]) {
      expect(rules(`.line-${state} .ln-col`)).toContain(`inset -4px 0 0 var(${color})`);
    }
    expect(rules(".line-self-proof-fog .ln-col")).toContain("repeating-linear-gradient");

    const { els } = runPage(html);
    const rows = els.get("l4-source-table")!.innerHTML;
    expect(rows).toContain('<tr class="line-fog"><td class="ln-col" data-ln="11">11</td>');
    expect(rows).toContain('<tr class="line-self-proof-fog"><td class="ln-col" data-ln="41">41</td>');
    expect(rows).toContain('<tr class="line-verified"><td class="ln-col" data-ln="1">1</td>');
  });

  it("draws minimap marks proportional to the line ranges of every non-verified state", () => {
    const { els } = runPage(renderHtmlFogMap(report()));
    const marks = [
      ...els
        .get("l4-minimap")!
        .innerHTML.matchAll(/<i class="mm-mark mm-([a-z-]+)" style="top:([\d.]+)%;height:([\d.]+)%" onclick="jumpToLine\((\d+)\)"/g),
    ].map((m) => ({ state: m[1], top: Number(m[2]), height: Number(m[3]), line: Number(m[4]) }));
    const expected = [
      { state: "fog", top: 10, height: 20, line: 11 },
      { state: "weak-evidence", top: 30, height: 10, line: 31 },
      { state: "self-proof-fog", top: 40, height: 10, line: 41 },
      { state: "fog-returned", top: 50, height: 10, line: 51 },
    ];
    expect(marks).toHaveLength(expected.length);
    marks.forEach((m, i) => {
      expect(m.state).toBe(expected[i].state);
      expect(m.line).toBe(expected[i].line);
      expect(Math.abs(m.top - expected[i].top)).toBeLessThanOrEqual(1);
      expect(Math.abs(m.height - expected[i].height)).toBeLessThanOrEqual(1);
    });
  });

  it("jumps to a line from the minimap and to the selected finding on entry", () => {
    const { ctx, scrolledTo } = runPage(renderHtmlFogMap(report()));
    ctx.jumpToLine(41);
    expect(scrolledTo).toContain('[data-ln="41"]');
    ctx.switchLevel(4, "src/big.ts", "CF-0002");
    expect(scrolledTo.at(-1)).toBe('[data-ln="31"]');
  });

  it("truncates finding titles with a tooltip holding the full symbol name", () => {
    const html = renderHtmlFogMap(report());
    const { els } = runPage(html);
    const list = els.get("l4-findings")!.innerHTML;
    expect(list).toContain(`<strong class="fc-title" title="[CF-0001] ${LONG_TITLE}">`);
    expect(els.get("l4-finding-detail")!.innerHTML).toContain(`title="[CF-0001] ${LONG_TITLE}"`);
    expect(html).toMatch(/\.fc-title\s*\{[^}]*text-overflow:\s*ellipsis/);
  });

  it("keeps the side columns and minimap sticky while the code scrolls", () => {
    const html = renderHtmlFogMap(report());
    expect(html).toMatch(/\.l4-side\s*\{[^}]*position:\s*sticky/);
    expect(html).toMatch(/\.minimap\s*\{[^}]*position:\s*sticky/);
    const l4 = /<section id="view-level-4"[\s\S]*?<\/section>/.exec(html)![0];
    expect(l4.match(/class="panel l4-side"/g)).toHaveLength(2);
    expect(l4).toContain('id="l4-minimap"');
  });
});
