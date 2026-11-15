import { describe, it, expect } from "vitest";
import { renderHtmlFogMap } from "../src/html-report.js";
import type {
  CodefogReport,
  DocFileSummary,
  EvidenceState,
  FileSummary,
  LocByState,
} from "../src/types.js";

function loc(partial: Partial<LocByState>): LocByState {
  return {
    "fog-returned": 0,
    fog: 0,
    "self-proof-fog": 0,
    "weak-evidence": 0,
    verified: 0,
    ...partial,
  };
}

function file(p: string, byState: Partial<LocByState>, riskScore: number): FileSummary {
  const l = loc(byState);
  const totalLoc = Object.values(l).reduce((a, b) => a + b, 0);
  const order: EvidenceState[] = ["fog-returned", "fog", "self-proof-fog", "weak-evidence", "verified"];
  return {
    path: p,
    modulePath: p.split("/").slice(0, -1).join("/") || ".",
    totalLoc,
    unverifiedLoc: totalLoc - l.verified,
    dominantState: order.find((s) => l[s] > 0) ?? "verified",
    trustScore: 50,
    riskScore,
    churn90d: 0,
    cyclomaticComplexity: 1,
    locByState: l,
    lines: [],
    lineStates: {},
    regions: [],
  };
}

function report(files: FileSummary[], docFiles?: DocFileSummary[]): CodefogReport {
  return {
    $schema: "https://codefog.dev/schemas/v1/report.json",
    version: "1.0.0",
    repository: { name: "demo", branch: "main", commit: "abc1234", generatedAt: "2026-01-01T00:00:00.000Z" },
    summary: {
      trustScore: 50,
      ...(docFiles ? { docTrustScore: 40, totalDocClaims: 6, docClaimsByState: loc({ fog: 6 }) } : {}),
      totalFiles: files.length,
      totalLoc: files.reduce((a, f) => a + f.totalLoc, 0),
      metrics: {
        lineCoveragePct: 50,
        branchCoveragePct: 50,
        checkedCoveragePct: 50,
        mutationScorePct: 0,
        pseudoTestedMethods: 0,
        contestedOracles: 0,
      },
      locByState: loc({ fog: 1 }),
    },
    ...(docFiles ? { docFiles, docClaims: [] } : {}),
    modules: [],
    findings: [],
    files,
  };
}

interface Tile {
  path: string;
  attrs: string;
  body: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

function level3(html: string): string {
  const m = /<section id="view-level-3"[\s\S]*?<\/section>/.exec(html);
  if (!m) throw new Error("no level 3");
  return m[0];
}

function tiles(section: string): Tile[] {
  const parts = section.split(/(?=<div class="tm-tile)/).slice(1);
  return parts.map((part) => {
    const open = /^<div class="tm-tile[^>]*>/.exec(part)![0];
    const style = /style="left:([\d.]+)%;top:([\d.]+)%;width:([\d.]+)%;height:([\d.]+)%"/.exec(open)!;
    return {
      path: /data-path="([^"]+)"/.exec(open)![1],
      attrs: open,
      body: part,
      left: Number(style[1]),
      top: Number(style[2]),
      width: Number(style[3]),
      height: Number(style[4]),
    };
  });
}

function segments(tile: Tile): Array<{ state: string; share: number }> {
  return [...tile.body.matchAll(/<i class="seg seg-([a-z-]+)" style="flex-basis:([\d.]+)%"/g)].map(
    (m) => ({ state: m[1], share: Number(m[2]) }),
  );
}

describe("Ticket 37: Level 3 area-proportional treemap with five-state segments and hotspots", () => {
  it("sizes tiles by executable LOC: a 300-line file gets 3x the area of a 100-line file", () => {
    const html = renderHtmlFogMap(
      report([file("src/big.ts", { fog: 300 }, 5), file("src/small.ts", { fog: 100 }, 4)]),
    );
    const [big, small] = ["src/big.ts", "src/small.ts"].map(
      (p) => tiles(level3(html)).find((t) => t.path === p)!,
    );
    const ratio = (big.width * big.height) / (small.width * small.height);
    expect(Math.abs(ratio - 3) / 3).toBeLessThanOrEqual(0.05);
  });

  it("fills each tile with five-state segments in worst-to-best order proportional to line counts", () => {
    const html = renderHtmlFogMap(report([file("src/mix.ts", { fog: 20, "weak-evidence": 80 }, 3)]));
    const [tile] = tiles(level3(html));
    expect(segments(tile)).toEqual([
      { state: "fog", share: 20 },
      { state: "weak-evidence", share: 80 },
    ]);
  });

  it("keeps the RETURNED badge on tiles that contain fog-returned lines", () => {
    const html = renderHtmlFogMap(
      report([
        file("src/returned.ts", { "fog-returned": 2, verified: 8 }, 6),
        file("src/plain.ts", { fog: 10 }, 2),
      ]),
    );
    const all = tiles(level3(html));
    expect(all.find((t) => t.path === "src/returned.ts")!.body).toContain("RETURNED");
    expect(all.find((t) => t.path === "src/plain.ts")!.body).not.toContain("RETURNED");
  });

  it("ranks the five highest-risk files #1-#5 and leaves the rest unranked", () => {
    const risks = [9.1, 8.2, 7.3, 6.4, 5.5, 4.6, 3.7];
    const html = renderHtmlFogMap(
      report(risks.map((r, i) => file(`src/f${i}.ts`, { fog: 10 + i }, r))),
    );
    const all = tiles(level3(html));
    for (let i = 0; i < risks.length; i++) {
      const t = all.find((x) => x.path === `src/f${i}.ts`)!;
      const rank = /<span class="tm-rank">#(\d)<\/span>/.exec(t.body);
      if (i < 5) {
        expect(rank?.[1]).toBe(String(i + 1));
        expect(t.attrs).toContain("tm-hotspot");
      } else {
        expect(rank).toBeNull();
        expect(t.attrs).not.toContain("tm-hotspot");
      }
    }
  });

  it("leaves zero-LOC and fully verified files out of the map and counts them in a note line", () => {
    const html = renderHtmlFogMap(
      report([
        file("src/fog.ts", { fog: 10 }, 3),
        file("src/types.ts", {}, 0),
        file("src/index.ts", {}, 0),
        file("src/ok.ts", { verified: 12 }, 0),
      ]),
    );
    const section = level3(html);
    expect(tiles(section).map((t) => t.path)).toEqual(["src/fog.ts"]);
    expect(section).toContain("1 verified files collapsed");
    expect(section).toContain("2 zero-LOC files not shown");
  });

  it("renders docs as a separate treemap whose areas follow claim counts", () => {
    const doc = (p: string, claims: Partial<LocByState>): DocFileSummary => {
      const c = loc(claims);
      const total = Object.values(c).reduce((a, b) => a + b, 0);
      return {
        path: p,
        modulePath: "docs",
        totalClaims: total,
        unverifiedClaims: total - c.verified,
        dominantState: "fog",
        trustScore: 0,
        riskScore: 1,
        claimsByState: c,
        lines: [],
        lineStates: {},
        claims: [],
      };
    };
    const html = renderHtmlFogMap(
      report([file("src/a.ts", { fog: 400 }, 3)], [doc("README.md", { fog: 4 }), doc("docs/guide.md", { fog: 2 })]),
    );
    const section = level3(html);
    const codeMap = /<div class="tm-canvas" data-map="code"[\s\S]*?(?=<div class="tm-canvas" data-map="docs")/.exec(section)![0];
    const docMap = section.slice(section.indexOf('data-map="docs"'));
    expect(tiles(codeMap).map((t) => t.path)).toEqual(["src/a.ts"]);
    const [readme, guide] = ["README.md", "docs/guide.md"].map((p) => tiles(docMap).find((t) => t.path === p)!);
    expect(readme.attrs).toContain('data-claims="4"');
    const ratio = (readme.width * readme.height) / (guide.width * guide.height);
    expect(Math.abs(ratio - 2) / 2).toBeLessThanOrEqual(0.05);
  });

  it("gives every tile a hover tooltip with its full path, including tiles too small for a label", () => {
    const html = renderHtmlFogMap(
      report([file("src/huge/module/file.ts", { fog: 5000 }, 2), file("src/deep/nested/tiny.ts", { fog: 1 }, 1)]),
    );
    const all = tiles(level3(html));
    for (const t of all) {
      expect(t.attrs).toMatch(new RegExp(`title="${t.path.replace(/[./]/g, "\\$&")}`));
    }
    const tiny = all.find((t) => t.path === "src/deep/nested/tiny.ts")!;
    expect(tiny.attrs).toContain("tm-small");
    expect(tiny.body).not.toContain('class="tm-label"');
  });
});
