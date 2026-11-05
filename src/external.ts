import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  ExternalIssue,
  ExternalOverlaySummary,
  LibyearDependencyDrift,
  LibyearSummary,
} from "./types.js";

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

export function normalizeExternalRelPath(rawPath: string, rootDir: string): string {
  let cleaned = rawPath.trim().replace(/^file:\/\//i, "");
  cleaned = toPosix(cleaned);
  const posixRoot = toPosix(path.resolve(rootDir));
  if (cleaned.startsWith(posixRoot + "/")) {
    cleaned = cleaned.slice(posixRoot.length + 1);
  }
  return cleaned.replace(/^\.\//, "");
}

function toPathList(input?: string | string[]): string[] {
  if (!input) return [];
  const rawList = Array.isArray(input) ? input : [input];
  const out: string[] = [];
  for (const item of rawList) {
    for (const part of item.split(",")) {
      const trimmed = part.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out;
}

interface RawSarifLocation {
  physicalLocation?: {
    artifactLocation?: {
      uri?: string;
    };
    region?: {
      startLine?: number;
      endLine?: number;
    };
  };
}

interface RawSarifResult {
  ruleId?: string;
  level?: string;
  message?: {
    text?: string;
    markdown?: string;
  };
  locations?: RawSarifLocation[];
}

interface RawSarifRun {
  tool?: {
    driver?: {
      name?: string;
    };
  };
  results?: RawSarifResult[];
}

interface RawSarifLog {
  version?: string;
  runs?: RawSarifRun[];
}

export function parseSarifContent(rawJson: string, rootDir: string): ExternalIssue[] {
  const parsed = JSON.parse(rawJson) as RawSarifLog;
  const issues: ExternalIssue[] = [];

  for (const run of parsed.runs ?? []) {
    const driverName = run.tool?.driver?.name?.trim() || "sarif";
    for (const res of run.results ?? []) {
      const ruleId = res.ruleId?.trim() || "sarif-rule";
      const message = (res.message?.text ?? res.message?.markdown ?? "").trim();
      const level = res.level;
      const locations = res.locations ?? [];
      for (const loc of locations) {
        const uri = loc.physicalLocation?.artifactLocation?.uri;
        if (!uri) continue;
        const file = normalizeExternalRelPath(uri, rootDir);
        const startLine = loc.physicalLocation?.region?.startLine ?? 1;
        const endLine = loc.physicalLocation?.region?.endLine ?? startLine;
        issues.push({
          source: driverName,
          tool: driverName,
          ruleId,
          message,
          file,
          line: startLine,
          startLine,
          endLine,
          ...(level ? { level } : {}),
        });
      }
    }
  }

  return issues;
}

interface RawKnipExportEntry {
  name?: string;
  symbol?: string;
  line?: number;
  endLine?: number;
  col?: number;
  message?: string;
  ruleId?: string;
  file?: string;
}

interface RawKnipIssueGroup {
  file?: string;
  line?: number;
  endLine?: number;
  name?: string;
  symbol?: string;
  type?: string;
  ruleId?: string;
  message?: string;
  exports?: Array<RawKnipExportEntry | string> | Record<string, RawKnipExportEntry>;
  types?: Array<RawKnipExportEntry | string> | Record<string, RawKnipExportEntry>;
  enumMembers?: Record<string, Array<RawKnipExportEntry | string>>;
  classMembers?: Record<string, Array<RawKnipExportEntry | string>>;
  duplicates?: Array<Array<RawKnipExportEntry | string>>;
}

interface RawKnipReport {
  files?: string[];
  issues?: RawKnipIssueGroup[] | Record<string, RawKnipIssueGroup>;
  exports?: RawKnipExportEntry[];
  unusedExports?: RawKnipExportEntry[];
}

function pushKnipCategoryEntries(
  issues: ExternalIssue[],
  file: string,
  entries: Array<RawKnipExportEntry | string> | Record<string, RawKnipExportEntry> | undefined,
  ruleId: string,
  label: string,
): void {
  if (!entries) return;
  const list: Array<RawKnipExportEntry | string> = Array.isArray(entries)
    ? entries
    : Object.values(entries);
  for (const item of list) {
    if (typeof item === "string") {
      issues.push({
        source: "knip",
        tool: "knip",
        ruleId,
        message: `${label} '${item}'`,
        file,
        line: 0,
        startLine: 0,
        endLine: 0,
        symbol: item,
      });
    } else {
      const sym = item.name ?? item.symbol ?? "unknown";
      const ln = item.line ?? 0;
      const endLn = item.endLine ?? ln;
      issues.push({
        source: "knip",
        tool: "knip",
        ruleId: item.ruleId ?? ruleId,
        message: item.message ?? `${label} '${sym}'`,
        file,
        line: ln,
        startLine: ln,
        endLine: endLn,
        symbol: sym,
      });
    }
  }
}

export function parseKnipContent(rawJson: string, rootDir: string): ExternalIssue[] {
  const parsed = JSON.parse(rawJson) as RawKnipReport;
  const issues: ExternalIssue[] = [];

  for (const f of parsed.files ?? []) {
    if (typeof f === "string") {
      const file = normalizeExternalRelPath(f, rootDir);
      issues.push({
        source: "knip",
        tool: "knip",
        ruleId: "unused-file",
        message: `Unused file '${file}'`,
        file,
        line: 1,
        startLine: 1,
        endLine: 1,
      });
    }
  }

  const issueGroups: Array<[string, RawKnipIssueGroup]> = [];
  if (Array.isArray(parsed.issues)) {
    for (const grp of parsed.issues) {
      if (grp?.file) {
        issueGroups.push([normalizeExternalRelPath(grp.file, rootDir), grp]);
      }
    }
  } else if (parsed.issues && typeof parsed.issues === "object") {
    for (const [k, grp] of Object.entries(parsed.issues)) {
      issueGroups.push([normalizeExternalRelPath(grp?.file ?? k, rootDir), grp]);
    }
  }

  for (const [file, grp] of issueGroups) {
    const beforeLen = issues.length;
    pushKnipCategoryEntries(issues, file, grp.exports, "unused-export", "Unused export");
    pushKnipCategoryEntries(issues, file, grp.types, "unused-type", "Unused exported type");
    if (grp.enumMembers && typeof grp.enumMembers === "object") {
      for (const members of Object.values(grp.enumMembers)) {
        pushKnipCategoryEntries(issues, file, members, "unused-enum-member", "Unused enum member");
      }
    }
    if (grp.classMembers && typeof grp.classMembers === "object") {
      for (const members of Object.values(grp.classMembers)) {
        pushKnipCategoryEntries(issues, file, members, "unused-class-member", "Unused class member");
      }
    }
    if (issues.length === beforeLen && (grp.name || grp.symbol || grp.line || grp.message)) {
      const sym = grp.name ?? grp.symbol;
      const ln = grp.line ?? 0;
      const endLn = grp.endLine ?? ln;
      issues.push({
        source: "knip",
        tool: "knip",
        ruleId: grp.ruleId ?? grp.type ?? "unused-export",
        message: grp.message ?? `Unused export '${sym ?? "unknown"}'`,
        file,
        line: ln,
        startLine: ln,
        endLine: endLn,
        ...(sym ? { symbol: sym } : {}),
      });
    }
  }

  for (const topList of [parsed.exports, parsed.unusedExports]) {
    for (const entry of topList ?? []) {
      if (!entry?.file) continue;
      const file = normalizeExternalRelPath(entry.file, rootDir);
      const sym = entry.name ?? entry.symbol ?? "unknown";
      const ln = entry.line ?? 0;
      const endLn = entry.endLine ?? ln;
      issues.push({
        source: "knip",
        tool: "knip",
        ruleId: entry.ruleId ?? "unused-export",
        message: entry.message ?? `Unused export '${sym}'`,
        file,
        line: ln,
        startLine: ln,
        endLine: endLn,
        symbol: sym,
      });
    }
  }

  return issues;
}

interface RawLibyearEntry {
  name?: string;
  dependency?: string;
  package?: string;
  current?: string;
  version?: string;
  latest?: string;
  available?: string;
  libyears?: number;
  drift?: number;
  releases?: number;
  major?: number;
  minor?: number;
  patch?: number;
}

interface RawLibyearObject {
  totalLibyears?: number;
  total?: number;
  libyears?: number;
  drift?: number;
  dependencies?: RawLibyearEntry[] | Record<string, RawLibyearEntry | number>;
  packages?: RawLibyearEntry[] | Record<string, RawLibyearEntry | number>;
}

export function parseLibyearContent(rawJson: string): LibyearSummary {
  const parsed = JSON.parse(rawJson) as RawLibyearEntry[] | RawLibyearObject;
  const dependencies: LibyearDependencyDrift[] = [];

  const pushEntry = (raw: RawLibyearEntry, fallbackName?: string): void => {
    const name = raw.name ?? raw.dependency ?? raw.package ?? fallbackName ?? "unknown";
    const libyearsVal = Number(raw.libyears ?? raw.drift ?? 0);
    const libyears = Number.isFinite(libyearsVal)
      ? Math.round(libyearsVal * 1000) / 1000
      : 0;
    const current = raw.current ?? raw.version;
    const latest = raw.latest ?? raw.available;
    dependencies.push({
      name,
      libyears,
      ...(current ? { current } : {}),
      ...(latest ? { latest } : {}),
      ...(typeof raw.releases === "number" ? { releases: raw.releases } : {}),
      ...(typeof raw.major === "number" ? { major: raw.major } : {}),
      ...(typeof raw.minor === "number" ? { minor: raw.minor } : {}),
      ...(typeof raw.patch === "number" ? { patch: raw.patch } : {}),
    });
  };

  let explicitTotal: number | undefined;

  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (item && typeof item === "object") {
        pushEntry(item);
      }
    }
  } else if (parsed && typeof parsed === "object") {
    if (typeof parsed.totalLibyears === "number") explicitTotal = parsed.totalLibyears;
    else if (typeof parsed.total === "number") explicitTotal = parsed.total;
    else if (
      typeof parsed.libyears === "number" &&
      !parsed.dependencies &&
      !parsed.packages
    ) {
      explicitTotal = parsed.libyears;
    }

    const depSource = parsed.dependencies ?? parsed.packages;
    if (Array.isArray(depSource)) {
      for (const item of depSource) {
        if (item && typeof item === "object") {
          pushEntry(item);
        }
      }
    } else if (depSource && typeof depSource === "object") {
      for (const [pkgName, val] of Object.entries(depSource)) {
        if (typeof val === "number") {
          pushEntry({ name: pkgName, libyears: val }, pkgName);
        } else if (val && typeof val === "object") {
          pushEntry(val, pkgName);
        }
      }
    }
  }

  const computedTotal =
    explicitTotal !== undefined
      ? explicitTotal
      : dependencies.reduce((acc, d) => acc + d.libyears, 0);

  return {
    source: "libyear",
    totalLibyears: Math.round(computedTotal * 1000) / 1000,
    dependencies,
  };
}

function mergeLibyearSummaries(
  existing: LibyearSummary | undefined,
  incoming: LibyearSummary,
): LibyearSummary {
  if (!existing) return incoming;
  const dependencies = [...existing.dependencies, ...incoming.dependencies];
  const totalLibyears =
    Math.round((existing.totalLibyears + incoming.totalLibyears) * 1000) / 1000;
  return {
    source: "libyear",
    totalLibyears,
    dependencies,
  };
}

export interface LoadExternalOverlayInput {
  sarifPath?: string | string[];
  knipPath?: string | string[];
  libyearPath?: string | string[];
  externalReportPath?: string | string[];
}

export async function loadExternalOverlay(
  rootDir: string,
  input: LoadExternalOverlayInput,
): Promise<ExternalOverlaySummary | undefined> {
  const sarifPaths = toPathList(input.sarifPath);
  const knipPaths = toPathList(input.knipPath);
  const libyearPaths = toPathList(input.libyearPath);
  const externalPaths = toPathList(input.externalReportPath);

  if (
    sarifPaths.length === 0 &&
    knipPaths.length === 0 &&
    libyearPaths.length === 0 &&
    externalPaths.length === 0
  ) {
    return undefined;
  }

  const issues: ExternalIssue[] = [];
  let libyear: LibyearSummary | undefined;

  for (const p of sarifPaths) {
    const abs = path.resolve(rootDir, p);
    const content = await fs.readFile(abs, "utf8");
    issues.push(...parseSarifContent(content, rootDir));
  }

  for (const p of knipPaths) {
    const abs = path.resolve(rootDir, p);
    const content = await fs.readFile(abs, "utf8");
    issues.push(...parseKnipContent(content, rootDir));
  }

  for (const p of libyearPaths) {
    const abs = path.resolve(rootDir, p);
    const content = await fs.readFile(abs, "utf8");
    libyear = mergeLibyearSummaries(libyear, parseLibyearContent(content));
  }

  for (const p of externalPaths) {
    const abs = path.resolve(rootDir, p);
    const content = await fs.readFile(abs, "utf8");
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (Array.isArray(parsed.runs)) {
      issues.push(...parseSarifContent(content, rootDir));
    } else if (
      Array.isArray(parsed) ||
      "totalLibyears" in parsed ||
      "dependencies" in parsed ||
      "packages" in parsed
    ) {
      libyear = mergeLibyearSummaries(libyear, parseLibyearContent(content));
    } else {
      issues.push(...parseKnipContent(content, rootDir));
    }
  }

  return {
    issues,
    ...(libyear ? { libyear } : {}),
  };
}

export function matchRegionExternalIssues(
  fileIssues: ExternalIssue[],
  symbol: string,
  startLine: number,
  endLine: number,
): ExternalIssue[] {
  return fileIssues
    .filter((issue) => {
      if (issue.symbol && issue.symbol === symbol) {
        return true;
      }
      if (issue.line > 0) {
        return issue.startLine <= endLine && issue.endLine >= startLine;
      }
      return false;
    })
    .map((issue) =>
      issue.line > 0
        ? issue
        : {
            ...issue,
            line: startLine,
            startLine,
            endLine: startLine,
          },
    );
}
