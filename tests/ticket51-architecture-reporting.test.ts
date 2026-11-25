import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeRepository } from "../src/analyzer.js";
import { runCli } from "../src/cli.js";
import { renderPrCommentMarkdown } from "../src/diff-pr.js";
import { renderHtmlFogMap } from "../src/html-report.js";
import { TERMINAL_MAX_COLUMNS, stripAnsi } from "../src/terminal-summary.js";

const ROUTES = "src/routes/export.ts";
const DB = "src/db/repo.ts";
const REASON = "Route handlers must use the service <entry>.";

describe("Ticket #51: structure and architecture reporting", () => {
  let rootDir: string;
  let knipPath: string;

  async function write(file: string, content: string) {
    const absolute = path.join(rootDir, file);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content);
  }

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefog-t51-"));
    knipPath = path.join(rootDir, "knip.json");
    await write(ROUTES, [
      'import { findReport } from "../db/repo.js";',
      "export function exportUnused(id: number) {",
      "  try {",
      "    if (id > 0) return findReport(id);",
      "  } catch {}",
      "  return null;",
      "}",
    ].join("\n"));
    await write(DB, "export function findReport(id: number) { return { id }; }\n");
    await write("knip.json", JSON.stringify({ issues: [{ file: ROUTES, exports: [{ name: "exportUnused", line: 2 }] }] }));
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  async function writeContract() {
    await write(".codefog/architecture.json", JSON.stringify({
      modules: { routes: ["src/routes/**"], db: ["src/db/**"] },
      rules: [{ from: "routes", to: "db", effect: "forbid", because: REASON }],
    }));
  }

  it("shows contextual architecture metrics, links to source, and renders selectable structure evidence", async () => {
    const plain = renderHtmlFogMap(await analyzeRepository({ rootDir }));
    expect(plain).not.toContain('data-metric="boundary-violations"');
    expect(plain).not.toContain('data-metric="propagation-cost"');
    expect(plain).not.toContain("Architecture Health");

    await writeContract();
    const report = await analyzeRepository({ rootDir, arch: true, knipPath });
    const html = renderHtmlFogMap(report);
    expect(html).toMatch(/data-metric="boundary-violations".*?metric-val">1</);
    expect(html).toMatch(/data-metric="propagation-cost".*?metric-val">[\d.]+%</);
    expect(html).toContain("Architecture Health");
    expect(html).toContain("routes → db");
    expect(html).toContain("Route handlers must use the service &lt;entry&gt;.");
    expect(html).not.toMatch(/(?:<link[^>]+href|<script[^>]+src)=/);

    const sourceButton = html.match(/<button type="button" class="architecture-source" data-file="src\/routes\/export\.ts" data-finding="([^"]+)" onclick="([^"]+)"/);
    expect(sourceButton).not.toBeNull();
    const elements = new Map<string, { innerHTML: string; textContent: string; classList: { toggle(): void } }>();
    const context = vm.createContext({
      document: {
        getElementById(id: string) {
          if (!elements.has(id)) elements.set(id, { innerHTML: "", textContent: "", classList: { toggle() {} } });
          return elements.get(id);
        },
        querySelectorAll: () => [],
        querySelector: () => undefined,
      },
    });
    vm.runInContext(/<script>([\s\S]*)<\/script>/.exec(html)![1]!, context);
    vm.runInContext(`(function () { ${sourceButton![2]} }).call({ dataset: { file: ${JSON.stringify(ROUTES)}, finding: ${JSON.stringify(sourceButton![1])} } })`, context);
    expect(elements.get("l4-file-title")?.textContent).toContain(ROUTES);
    expect(elements.get("l4-finding-detail")?.innerHTML).toContain("Route handlers must use the service &lt;entry&gt;.");

    const finding = report.findings.find((item) => item.tags?.includes("dead-code-fog"))!;
    vm.runInContext(`switchLevel(4, ${JSON.stringify(ROUTES)}, ${JSON.stringify(finding.id)})`, context);
    const detail = elements.get("l4-finding-detail")?.innerHTML;
    expect(detail).toMatch(/Cognitive Complexity:<\/strong> \d+/);
    expect(detail).toMatch(/Max Nesting Depth:<\/strong> \d+/);
    expect(detail).toContain("Error masking lines:");
    expect(detail).toContain("jumpToLine(5)");
    expect(detail).toContain("<code>dead-code-fog</code>");
    expect(detail).toMatch(/delet|remov/i);
  });

  it("writes a compact PR section only for new structure or boundary regressions", async () => {
    await writeContract();
    const report = await analyzeRepository({ rootDir });
    const baseline = {
      baseRef: "main",
      coverageUpEvidenceDown: false,
      alertHeadline: "No evidence regression.",
      fogReturnedFiles: [],
      weakenedFiles: [],
      beforeSummary: { trustScore: report.summary.trustScore, metrics: report.summary.metrics, files: [] },
    };
    expect(renderPrCommentMarkdown({ ...report, diff: baseline })).not.toContain("Structural & Architecture Delta");

    const structuralRot = {
      complexitySpikes: [{ file: ROUTES, symbol: "exportUnused", line: 2, before: 1, after: 16, delta: 15 }],
      addedErrorMasking: [{ file: ROUTES, line: 5, pattern: "empty-catch" as const }],
      addedDuplicatedBlocks: [{ file: ROUTES, startLine: 2, endLine: 7, duplicateFile: DB, duplicateStartLine: 3, duplicateEndLine: 8 }],
    };
    const structuralComment = renderPrCommentMarkdown({ ...report, diff: { ...baseline, structuralRot } });
    expect(structuralComment).toContain("> [!NOTE]");
    expect(structuralComment).toContain("### Structural & Architecture Delta");
    expect(structuralComment).toContain("1 → 16 (+15)");
    expect(structuralComment).toContain("empty-catch");
    expect(structuralComment).toContain(`${ROUTES}:2-7`);
    expect(structuralComment).toContain(`${DB}:3-8`);

    const newBoundaryViolations = report.architecture!.boundaryViolations;
    const boundaryComment = renderPrCommentMarkdown({ ...report, diff: { ...baseline, newBoundaryViolations } });
    expect(boundaryComment).toContain("> [!WARNING]");
    expect(boundaryComment).toContain("PR introduces 1 unbaselined architecture boundary violation.");
    expect(boundaryComment).toContain("`routes` → `db`");
    expect(boundaryComment).toContain("Route handlers must use the service &lt;entry&gt;.");
  });

  it("appends the same architecture totals to plain and bounded colored summaries", async () => {
    async function summary(color: boolean, arch: boolean) {
      let out = "";
      const exitCode = await runCli(["--root", rootDir, "--fail-on", "none", ...(arch ? ["--arch"] : [])], {
        color, stdout: (value) => { out += value; }, stderr: () => {},
      });
      expect(exitCode).toBe(0);
      return out;
    }

    const plain = await summary(false, false);
    const enabled = await summary(false, true);
    const colored = stripAnsi(await summary(true, true));
    const archLine = enabled.trimEnd().split("\n").at(-1)!;
    expect(archLine).toMatch(/^Architecture: Violations=0 Cycles=0 UnstableHubs=0 ImplicitCoupling=0 Propagation=[\d.]+%$/);
    expect(enabled).toBe(plain + archLine + "\n");
    expect(colored).toContain(archLine);
    expect(colored.split("\n").every((line) => [...line].length <= TERMINAL_MAX_COLUMNS)).toBe(true);
  });
});
