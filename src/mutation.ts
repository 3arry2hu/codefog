import * as fs from "node:fs/promises";
import * as path from "node:path";
import { findFilesByExtensionInRepo } from "./polyglot.js";
import type { SurvivingMutant } from "./types.js";

export interface StrykerMutantRecord {
  id: string;
  line: number;
  endLine: number;
  original: string;
  mutated: string;
  testsRun: number;
  killed: boolean;
  status: string;
}

export interface StrykerFileSummary {
  mutants: StrykerMutantRecord[];
}

export interface ParsedStrykerReport {
  totalMutants: number;
  killedMutants: number;
  mutationScorePct: number;
  byFile: Map<string, StrykerFileSummary>;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function normalizeRelPath(rawPath: string, rootDir: string): string {
  const posixRaw = toPosix(rawPath.trim());
  const posixRoot = toPosix(path.resolve(rootDir));
  if (posixRaw.startsWith(posixRoot + "/")) {
    return posixRaw.slice(posixRoot.length + 1);
  }
  return posixRaw.replace(/^\.\//, "");
}

interface RawStrykerMutant {
  id?: string | number;
  mutatorName?: string;
  replacement?: string;
  originalLines?: string;
  location?: {
    start?: { line?: number; column?: number };
    end?: { line?: number; column?: number };
  };
  status?: string;
  coveredBy?: unknown[];
  testsCompleted?: number;
}

interface RawStrykerFile {
  source?: string;
  mutants?: RawStrykerMutant[];
}

interface RawStrykerReport {
  files?: Record<string, RawStrykerFile>;
}

function extractOriginalSnippet(
  source: string | undefined,
  location: RawStrykerMutant["location"],
  fallbackOriginal: string | undefined,
): string {
  if (fallbackOriginal) return fallbackOriginal;
  if (!source || !location?.start?.line) return "";
  const lines = source.split(/\r?\n/);
  const startLine = location.start.line;
  const endLine = location.end?.line ?? startLine;
  if (startLine === endLine) {
    const lineText = lines[startLine - 1] ?? "";
    if (
      location.start.column !== undefined &&
      location.end?.column !== undefined &&
      location.end.column > location.start.column
    ) {
      // Stryker columns can be 0-based or 1-based depending on schema version; try 1-based first if it looks like an expression
      const sub1 = lineText.slice(location.start.column - 1, location.end.column - 1).trim();
      if (sub1) return sub1;
      const sub0 = lineText.slice(location.start.column, location.end.column).trim();
      if (sub0) return sub0;
    }
    return lineText.trim();
  }
  return lines
    .slice(startLine - 1, endLine)
    .join(" ")
    .trim();
}

interface RawCargoMutantEntry {
  scenario?: {
    Mutant?: {
      package?: string;
      file?: string;
      function?: { function_name?: string; return_type?: string };
      span?: {
        start?: { line?: number; column?: number };
        end?: { line?: number; column?: number };
      };
      replacement?: string;
      genre?: string;
    };
  };
  summary?: string;
}

interface RawCargoMutantsReport {
  outcomes?: RawCargoMutantEntry[];
}

export async function parsePitestXml(
  rawXml: string,
  rootDir: string,
): Promise<ParsedStrykerReport> {
  const byFile = new Map<string, StrykerFileSummary>();
  let totalMutants = 0;
  let killedMutants = 0;
  let seq = 1;
  const javaFiles = await findFilesByExtensionInRepo(rootDir, rootDir, ".java");

  const mutRe = /<mutation\s+([^>]+)>([\s\S]*?)<\/mutation>/g;
  let mm: RegExpExecArray | null;

  while ((mm = mutRe.exec(rawXml)) !== null) {
    const attrs = mm[1]!;
    const body = mm[2]!;

    const statusMatch = /\bstatus="([^"]+)"/.exec(attrs);
    const statusRaw = statusMatch ? statusMatch[1]! : "SURVIVED";
    if (statusRaw === "NON_VIABLE" || statusRaw === "RUN_ERROR") {
      continue;
    }

    const getTag = (tag: string): string => {
      const m = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(body);
      return m ? m[1]!.trim() : "";
    };

    const sourceFile = getTag("sourceFile");
    const mutatedClass = getTag("mutatedClass");
    const mutatedMethod = getTag("mutatedMethod");
    const lineNum = Number.parseInt(getTag("lineNumber") || "1", 10) || 1;
    const description = getTag("description") || getTag("mutator");
    const testsRunMatch = /\bnumberOfTestsRun="(\d+)"/.exec(attrs);
    const testsRun = testsRunMatch ? Number.parseInt(testsRunMatch[1]!, 10) : 1;

    const pkgParts = mutatedClass.split(".").slice(0, -1);
    const suffix =
      pkgParts.length > 0 ? `${pkgParts.join("/")}/${sourceFile}` : sourceFile;
    const relPath =
      javaFiles.find((f) => f === suffix || f.endsWith(`/${suffix}`)) ??
      `src/main/java/${suffix}`;

    totalMutants++;
    const killed =
      statusRaw === "KILLED" || statusRaw === "TIMED_OUT" || statusRaw === "MEMORY_ERROR";
    if (killed) {
      killedMutants++;
    }

    let fileSummary = byFile.get(relPath);
    if (!fileSummary) {
      fileSummary = { mutants: [] };
      byFile.set(relPath, fileSummary);
    }

    fileSummary.mutants.push({
      id: `pit_${seq++}`,
      line: lineNum,
      endLine: lineNum,
      original: mutatedMethod,
      mutated: description,
      testsRun,
      killed,
      status: killed ? "Killed" : "Survived",
    });
  }

  const mutationScorePct =
    totalMutants > 0 ? Math.round((killedMutants / totalMutants) * 1000) / 10 : 0;

  return {
    totalMutants,
    killedMutants,
    mutationScorePct,
    byFile,
  };
}

export async function loadStrykerReport(
  rootDir: string,
  strykerPath: string,
): Promise<ParsedStrykerReport> {
  const absPath = path.resolve(rootDir, strykerPath);
  const rawContent = await fs.readFile(absPath, "utf8");
  const trimmed = rawContent.trimStart();
  if (trimmed.startsWith("<?xml") || trimmed.startsWith("<mutations")) {
    return parsePitestXml(rawContent, rootDir);
  }
  const parsed = JSON.parse(rawContent) as RawStrykerReport & RawCargoMutantsReport;

  const byFile = new Map<string, StrykerFileSummary>();
  let totalMutants = 0;
  let killedMutants = 0;

  if (Array.isArray(parsed.outcomes)) {
    let seq = 1;
    for (const outcome of parsed.outcomes) {
      const mut = outcome.scenario?.Mutant;
      if (!mut?.file) continue;
      const summary = outcome.summary ?? "Missed";
      if (summary === "Unviable" || summary === "Ignored") {
        continue;
      }
      totalMutants++;
      const killed = summary === "Caught" || summary === "Timeout";
      if (killed) {
        killedMutants++;
      }
      const relPath = normalizeRelPath(mut.file, rootDir);
      const startLine = mut.span?.start?.line ?? 1;
      const endLine = mut.span?.end?.line ?? startLine;
      let fileSummary = byFile.get(relPath);
      if (!fileSummary) {
        fileSummary = { mutants: [] };
        byFile.set(relPath, fileSummary);
      }
      fileSummary.mutants.push({
        id: `cargo_mut_${seq++}`,
        line: startLine,
        endLine,
        original: mut.function?.function_name ?? "",
        mutated: mut.replacement ?? "",
        testsRun: 1,
        killed,
        status: killed ? "Killed" : "Survived",
      });
    }

    const mutationScorePct =
      totalMutants > 0 ? Math.round((killedMutants / totalMutants) * 1000) / 10 : 0;

    return {
      totalMutants,
      killedMutants,
      mutationScorePct,
      byFile,
    };
  }

  for (const [fileKey, fileData] of Object.entries(parsed.files ?? {})) {
    const relPath = normalizeRelPath(fileKey, rootDir);
    const records: StrykerMutantRecord[] = [];

    for (const m of fileData.mutants ?? []) {
      const status = m.status ?? "Survived";
      if (status === "Ignored" || status === "CompileError") {
        continue;
      }
      totalMutants++;
      const killed = status === "Killed" || status === "Timeout";
      if (killed) {
        killedMutants++;
      }
      const startLine = m.location?.start?.line ?? 1;
      const endLine = m.location?.end?.line ?? startLine;
      const testsRun = Array.isArray(m.coveredBy)
        ? m.coveredBy.length
        : typeof m.testsCompleted === "number"
          ? m.testsCompleted
          : killed
            ? 1
            : 0;

      records.push({
        id: String(m.id ?? `mut_${records.length + 1}`),
        line: startLine,
        endLine,
        original: extractOriginalSnippet(fileData.source, m.location, m.originalLines),
        mutated: m.replacement ?? "",
        testsRun,
        killed,
        status,
      });
    }

    byFile.set(relPath, { mutants: records });
  }

  const mutationScorePct =
    totalMutants > 0 ? Math.round((killedMutants / totalMutants) * 1000) / 10 : 0;

  return {
    totalMutants,
    killedMutants,
    mutationScorePct,
    byFile,
  };
}

export function getSpanMutationSummary(
  fileSummary: StrykerFileSummary | undefined,
  startLine: number,
  endLine: number,
): {
  totalInSpan: number;
  killedInSpan: number;
  survivingMutants: SurvivingMutant[];
} {
  if (!fileSummary) {
    return { totalInSpan: 0, killedInSpan: 0, survivingMutants: [] };
  }
  const inSpan = fileSummary.mutants.filter(
    (m) => m.line >= startLine && m.line <= endLine,
  );
  const killedInSpan = inSpan.filter((m) => m.killed).length;
  const survivingMutants: SurvivingMutant[] = inSpan
    .filter((m) => !m.killed)
    .map((m) => ({
      id: m.id,
      line: m.line,
      original: m.original,
      mutated: m.mutated,
      testsRun: m.testsRun,
      killed: false,
    }));

  return {
    totalInSpan: inSpan.length,
    killedInSpan,
    survivingMutants,
  };
}
