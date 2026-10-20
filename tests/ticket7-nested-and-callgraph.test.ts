import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { analyzeRepository } from "../src/analyzer.js";

describe("Optimization: Nested function deduplication & Call-Graph assertion propagation", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefog-opt-"));
    await fs.mkdir(path.join(tmpDir, "src", "orders"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "tests"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "coverage"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("does not double-count nested helper functions or falsely flag them as pseudo-tested, and propagates strong assertions across call graph", async () => {
    // 1. Helper module called by service.ts (not directly imported by test file)
    await fs.writeFile(
      path.join(tmpDir, "src", "orders", "pricing.ts"),
      [
        "export function calculateSubtotal(qty: number, unitPrice: number): number {",
        "  function clampPositive(n: number): number {",
        "    return n < 0 ? 0 : n;",
        "  }",
        "  return clampPositive(qty) * clampPositive(unitPrice);",
        "}",
        "",
        "export function buildAuditTag(orderId: string): string {",
        "  return `audit:${orderId.trim()}`;",
        "}",
      ].join("\n"),
      "utf8",
    );

    // 2. Entry service module calling pricing.ts functions
    await fs.writeFile(
      path.join(tmpDir, "src", "orders", "service.ts"),
      [
        "import { calculateSubtotal, buildAuditTag } from './pricing.js';",
        "",
        "export function checkoutOrder(qty: number, unitPrice: number): number {",
        "  const addTax = (subtotal: number) => Math.round(subtotal * 1.1);",
        "  return addTax(calculateSubtotal(qty, unitPrice));",
        "}",
        "",
        "export function pingAudit(orderId: string): string {",
        "  return buildAuditTag(orderId);",
        "}",
      ].join("\n"),
      "utf8",
    );

    // 3. Integration test: asserts on checkoutOrder outcome, but calls pingAudit without assertion
    await fs.writeFile(
      path.join(tmpDir, "tests", "orders.test.ts"),
      [
        "import { describe, it, expect } from 'vitest';",
        "import { checkoutOrder, pingAudit } from '../src/orders/service.js';",
        "",
        "describe('orders integration', () => {",
        "  it('computes total with tax via checkoutOrder', () => {",
        "    expect(checkoutOrder(2, 50)).toBe(110);",
        "  });",
        "",
        "  it('calls pingAudit without asserting outcome', () => {",
        "    pingAudit('ord_123');",
        "  });",
        "});",
      ].join("\n"),
      "utf8",
    );

    // LCOV: all lines and branches in both files are executed
    const lcovContent = [
      "TN:",
      "SF:src/orders/pricing.ts",
      "FN:1,calculateSubtotal",
      "FN:2,clampPositive",
      "FN:8,buildAuditTag",
      "FNF:3",
      "FNH:3",
      "FNDA:1,calculateSubtotal",
      "FNDA:2,clampPositive",
      "FNDA:1,buildAuditTag",
      "DA:1,1",
      "DA:2,2",
      "DA:3,2",
      "DA:5,1",
      "DA:8,1",
      "DA:9,1",
      "LF:6",
      "LH:6",
      "end_of_record",
      "TN:",
      "SF:src/orders/service.ts",
      "FN:3,checkoutOrder",
      "FN:4,addTax",
      "FN:8,pingAudit",
      "FNF:3",
      "FNH:3",
      "FNDA:1,checkoutOrder",
      "FNDA:1,addTax",
      "FNDA:1,pingAudit",
      "DA:3,1",
      "DA:4,1",
      "DA:5,1",
      "DA:8,1",
      "DA:9,1",
      "LF:5",
      "LH:5",
      "end_of_record",
    ].join("\n");

    await fs.writeFile(path.join(tmpDir, "coverage", "lcov.info"), lcovContent, "utf8");

    const report = await analyzeRepository({ rootDir: tmpDir });

    // Total instrumented LOC across both files must be exactly 6 + 5 = 11 (no double-counting of nested functions!)
    expect(report.summary.totalLoc).toBe(11);

    // Nested functions (clampPositive, addTax) must NOT be separate regions or pseudo-tested methods
    const allRegionSymbols = report.files.flatMap((f) => f.regions.map((r) => r.symbol));
    expect(allRegionSymbols).toEqual(
      expect.arrayContaining(["calculateSubtotal", "buildAuditTag", "checkoutOrder", "pingAudit"]),
    );
    expect(allRegionSymbols).not.toContain("clampPositive");
    expect(allRegionSymbols).not.toContain("addTax");

    // checkoutOrder (3 lines) and its callee calculateSubtotal (4 lines) both have strong outcome assertions -> 7 verified & checked lines
    // pingAudit (2 lines) and its callee buildAuditTag (2 lines) have 0 outcome assertions -> 4 weak-evidence lines, 2 pseudo-tested methods
    expect(report.summary.locByState.verified).toBe(7);
    expect(report.summary.locByState["weak-evidence"]).toBe(4);
    expect(report.summary.metrics.pseudoTestedMethods).toBe(2);
    expect(report.summary.metrics.checkedCoveragePct).toBe(63.6);
  });
});
