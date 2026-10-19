import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { analyzeRepository } from "../src/analyzer.js";

describe("Ticket 2: AST assertion dataflow, Weak Evidence, Checked Coverage & Pseudo-tested Methods", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefog-t2-"));
    await fs.mkdir(path.join(tmpDir, "src", "billing"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "tests"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "coverage"), { recursive: true });

    await fs.writeFile(
      path.join(tmpDir, "src", "billing", "invoice.ts"),
      [
        "export function formatInvoice(cents: number): string {",
        "  return `$${(cents / 100).toFixed(2)}`;",
        "}",
        "",
        "export function syncWebhook(payload: { id: string }): boolean {",
        "  const normalized = payload.id.trim();",
        "  return normalized.length > 0;",
        "}",
        "",
        "export function applyDiscount(total: number, isVip: boolean): number {",
        "  if (isVip) {",
        "    return total * 0.8;",
        "  }",
        "  return total;",
        "}",
      ].join("\n"),
      "utf8",
    );

    // Test file exercising invoice.ts
    await fs.writeFile(
      path.join(tmpDir, "tests", "invoice.test.ts"),
      [
        "import { describe, it, expect } from 'vitest';",
        "import { formatInvoice, syncWebhook, applyDiscount } from '../src/billing/invoice.js';",
        "",
        "describe('invoice', () => {",
        "  it('formats cents into dollars with strong assertion', () => {",
        "    const out = formatInvoice(250);",
        "    expect(out).toBe('$2.50');",
        "  });",
        "",
        "  it('executes syncWebhook without any assertion', () => {",
        "    syncWebhook({ id: 'evt_1' });",
        "  });",
        "",
        "  it('executes syncWebhook with weak toBeDefined assertion only', () => {",
        "    const res = syncWebhook({ id: 'evt_2' });",
        "    expect(res).toBeDefined();",
        "  });",
        "",
        "  it('checks applyDiscount only on non-VIP branch', () => {",
        "    expect(applyDiscount(100, false)).toBe(100);",
        "  });",
        "});",
      ].join("\n"),
      "utf8",
    );

    // LCOV: all 3 functions executed, but applyDiscount has 1 of 2 branches hit
    const lcovContent = [
      "TN:",
      "SF:src/billing/invoice.ts",
      "FN:1,formatInvoice",
      "FN:5,syncWebhook",
      "FN:10,applyDiscount",
      "FNF:3",
      "FNH:3",
      "FNDA:1,formatInvoice",
      "FNDA:2,syncWebhook",
      "FNDA:1,applyDiscount",
      "DA:1,1",
      "DA:2,1",
      "DA:5,2",
      "DA:6,2",
      "DA:7,2",
      "DA:10,1",
      "DA:11,1",
      "DA:12,0",
      "DA:14,1",
      "LF:9",
      "LH:8",
      "BRDA:11,0,0,0",
      "BRDA:11,0,1,1",
      "BRF:2",
      "BRH:1",
      "end_of_record",
    ].join("\n");

    await fs.writeFile(path.join(tmpDir, "coverage", "lcov.info"), lcovContent, "utf8");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("downgrades pseudo-tested and branch-incomplete functions to weak-evidence and computes checkedCoveragePct", async () => {
    const report = await analyzeRepository({ rootDir: tmpDir });

    // Total lines found = 9, hit = 8
    // formatInvoice (2 lines): executed + strong assertion + 100% branch -> verified (2 lines), checked (2 lines)
    // syncWebhook (3 lines): executed by 2 tests, 0 outcome assertions -> weak-evidence (3 lines), pseudoTested = true, NOT checked
    // applyDiscount (4 lines: 3 hit, 1 unhit): has strong assertion (checked = 3 lines), but branch coverage 50% < 100% -> hit lines downgraded to weak-evidence (3 lines), unhit line 12 is fog (1 line)
    expect(report.summary.metrics.pseudoTestedMethods).toBe(1);
    // Checked lines = 2 (formatInvoice) + 3 (applyDiscount hit lines with strong assertion) = 5 out of 9 = 55.6%
    expect(report.summary.metrics.checkedCoveragePct).toBe(55.6);

    expect(report.summary.locByState.verified).toBe(2);
    expect(report.summary.locByState["weak-evidence"]).toBe(6);
    expect(report.summary.locByState.fog).toBe(1);

    const syncFinding = report.findings.find((f) => f.location.symbol === "syncWebhook");
    expect(syncFinding).toBeDefined();
    expect(syncFinding?.state).toBe("weak-evidence");
    expect(syncFinding?.evidence.executedByTests).toBe(2);
    expect(syncFinding?.evidence.assertionsOnOutcome).toBe(0);
    expect(syncFinding?.evidence.pseudoTested).toBe(true);
    expect(syncFinding?.suggestedAction).toContain("syncWebhook");

    const discountFinding = report.findings.find((f) => f.location.symbol === "applyDiscount");
    expect(discountFinding).toBeDefined();
    expect(discountFinding?.state).toBe("weak-evidence");
    expect(discountFinding?.evidence.executedByTests).toBe(1);
    expect(discountFinding?.evidence.assertionsOnOutcome).toBe(1);
    expect(discountFinding?.evidence.pseudoTested).toBe(false);
  });
});
