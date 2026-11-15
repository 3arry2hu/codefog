import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { runCli } from "../src/cli.js";
import { STATE_COLORS } from "../src/scoring.js";

const DARK_STATES: Record<string, string> = {
  "--state-verified": "#15243A",
  "--state-weak": "#2F4868",
  "--state-self-proof": "#6E88AA",
  "--state-self-proof-hatch": "#89A0BE",
  "--state-fog": "#C3D0E0",
  "--state-returned": "#FF8A3D",
};

const FIVE_STATE_HEXES = [
  ...Object.values(STATE_COLORS),
  "#587294",
  ...Object.values(DARK_STATES),
].map((h) => h.toUpperCase());

function block(css: string, startIdx: number): { body: string; end: number } {
  const open = css.indexOf("{", startIdx);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return { body: css.slice(open + 1, i), end: i + 1 };
  }
  throw new Error("unbalanced CSS");
}

function vars(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function chroma(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return Math.max(r!, g!, b!) - Math.min(r!, g!, b!);
}

describe("Ticket 40: dark theme and design variables", () => {
  let tmpDir: string;
  let html: string;
  let css: string;
  let lightVars: Record<string, string>;
  let darkVars: Record<string, string>;
  let cssWithoutDefinitions: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefog-t40-"));
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "src", "math.ts"),
      "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
      "utf8",
    );
    await runCli(["--root", tmpDir, "--html", "out.html"], { stdout: () => {}, stderr: () => {} });
    html = await fs.readFile(path.join(tmpDir, "out.html"), "utf8");
    css = html.slice(html.indexOf("<style>") + 7, html.indexOf("</style>"));

    const rootStart = css.indexOf(":root");
    const light = block(css, rootStart);
    lightVars = vars(light.body);
    const mediaStart = css.indexOf("@media (prefers-color-scheme: dark)");
    expect(mediaStart).toBeGreaterThan(-1);
    const media = block(css, mediaStart);
    darkVars = vars(block(media.body, media.body.indexOf(":root")).body);
    cssWithoutDefinitions = css.slice(0, rootStart) + css.slice(light.end, mediaStart) + css.slice(media.end);
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("dark media query sets the ADR-0006 five-state values and canvas", () => {
    for (const [name, value] of Object.entries(DARK_STATES)) {
      expect(darkVars[name]?.toUpperCase()).toBe(value);
    }
    expect(darkVars["--bg-canvas"]?.toUpperCase()).toBe("#0E1A2B");
  });

  it("dark theme keeps the fog-first lightness ladder and a single saturated hue", () => {
    const ladder = ["--state-verified", "--state-weak", "--state-self-proof", "--state-fog"].map((v) =>
      luminance(darkVars[v]!),
    );
    expect([...ladder].sort((a, b) => a - b)).toEqual(ladder);
    expect(luminance(darkVars["--state-verified"]!) - luminance(darkVars["--bg-canvas"]!)).toBeLessThan(0.01);
    const saturated = Object.keys(DARK_STATES).filter((v) => chroma(darkVars[v]!) > 0.4);
    expect(saturated).toEqual(["--state-returned"]);
  });

  it("dark code-line tints over the card keep weak < self-proof < fog in lightness", () => {
    const card = darkVars["--bg-card"]!;
    const blend = (rgba: string): string => {
      const [r, g, b, a] = rgba.match(/[\d.]+/g)!.map(Number);
      const base = [1, 3, 5].map((i) => parseInt(card.slice(i, i + 2), 16));
      return (
        "#" +
        [r!, g!, b!]
          .map((c, i) => Math.round(base[i]! + (c - base[i]!) * a!).toString(16).padStart(2, "0"))
          .join("")
      );
    };
    const ladder = ["--tint-line-weak", "--tint-line-self-proof", "--tint-line-fog"].map((v) =>
      luminance(blend(darkVars[v]!)),
    );
    expect([...ladder].sort((a, b) => a - b)).toEqual(ladder);
  });

  it("light theme still defines the ADR-0001 colors", () => {
    expect(lightVars["--state-verified"]).toBe(STATE_COLORS.verified);
    expect(lightVars["--state-weak"]).toBe(STATE_COLORS["weak-evidence"]);
    expect(lightVars["--state-self-proof"]).toBe(STATE_COLORS["self-proof-fog"]);
    expect(lightVars["--state-fog"]).toBe(STATE_COLORS.fog);
    expect(lightVars["--state-returned"]).toBe(STATE_COLORS["fog-returned"]);
  });

  it("every dark override has a light counterpart", () => {
    for (const name of Object.keys(darkVars)) expect(lightVars).toHaveProperty(name);
  });

  it("outside the variable definitions no color literal appears in CSS, and no five-state hex anywhere else in the page", () => {
    expect(cssWithoutDefinitions).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(cssWithoutDefinitions).not.toMatch(/rgba?\(/);
    const pageWithoutCss = html.replace(/<style>[\s\S]*?<\/style>/, "");
    for (const hex of FIVE_STATE_HEXES) expect(pageWithoutCss.toUpperCase()).not.toContain(hex);
    for (const m of cssWithoutDefinitions.matchAll(/var\((--[\w-]+)\)/g)) {
      if (m[1] === "--sticky-offset" || m[1]!.startsWith("--font")) continue;
      expect(lightVars).toHaveProperty(m[1]!);
    }
  });

  it("numbers are tabular and labels use the mono uppercase tracked style", () => {
    expect(css).toMatch(/body\s*\{[^}]*font-variant-numeric:\s*tabular-nums/);
    expect(css).toMatch(
      /\.ls-label, \.metric-label, \.kpi-label \{[^}]*var\(--font-mono\)[^}]*letter-spacing:[^}]*text-transform: uppercase/,
    );
  });

  it("stays a single offline file with no external stylesheets, fonts or scripts", () => {
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/@import/);
    expect(html).not.toMatch(/url\(\s*['"]?https?:/i);
    expect(html).not.toMatch(/(?:href|src)=["']https?:/i);
  });
});
