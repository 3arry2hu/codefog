import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ExpectationRecord {
  id: string;
  file: string;
  symbol: string;
  expectedLiteral: string;
}

export interface DefectRecord {
  id: string;
  file: string;
  symbol: string;
  inputLiteral: string;
  expectedLiteral: string;
  rejectedLiteral?: string;
}

export interface OracleBundle {
  expectations: ExpectationRecord[];
  defects: DefectRecord[];
  expectationCommit: string | null;
  defectCommit: string | null;
}

export interface SymbolOracleVerdict {
  contested: boolean;
  contestIds: string[];
  independentlyConfirmed: boolean;
  confirmingIds: string[];
  missedBoundary: boolean;
  missedIds: string[];
  confirmedExpectedLiteral?: string;
}

const DEFAULT_EXPECTATIONS = "oracles/expectations.json";
const DEFAULT_DEFECTS = "oracles/defects.json";

export async function lastCommitHash(rootDir: string, relPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["log", "-1", "--format=%H", "--", relPath],
      { cwd: rootDir },
    );
    const hash = stdout.trim();
    return hash || null;
  } catch {
    return null;
  }
}

export async function loadOracleBundle(
  rootDir: string,
  options: { expectationsPath?: string; defectsPath?: string } = {},
): Promise<OracleBundle> {
  const expectationsFile = await resolveManifest(
    rootDir,
    options.expectationsPath,
    DEFAULT_EXPECTATIONS,
  );
  const defectsFile = await resolveManifest(rootDir, options.defectsPath, DEFAULT_DEFECTS);

  const expectations = expectationsFile
    ? parseExpectations(await fs.readFile(expectationsFile.abs, "utf8"), expectationsFile.rel)
    : [];
  const defects = defectsFile
    ? parseDefects(await fs.readFile(defectsFile.abs, "utf8"), defectsFile.rel)
    : [];

  return {
    expectations,
    defects,
    expectationCommit: expectationsFile
      ? await lastCommitHash(rootDir, expectationsFile.rel)
      : null,
    defectCommit: defectsFile ? await lastCommitHash(rootDir, defectsFile.rel) : null,
  };
}

export function judgeSymbolOracle(input: {
  file: string;
  symbol: string;
  testSources: string[];
  expectations: ExpectationRecord[];
  defects: DefectRecord[];
  expectationIndependent: boolean;
  defectIndependent: boolean;
}): SymbolOracleVerdict {
  const expectations = input.expectations.filter(
    (record) => samePath(record.file, input.file) && record.symbol === input.symbol,
  );
  const defects = input.defects.filter(
    (record) => samePath(record.file, input.file) && record.symbol === input.symbol,
  );
  const combined = input.testSources.join("\n");
  const literals = new Set(extractAssertedLiterals(input.symbol, combined));
  const contestIds: string[] = [];
  const confirmingIds: string[] = [];
  const missedIds: string[] = [];

  for (const expectation of expectations) {
    const want = normalizeLiteral(expectation.expectedLiteral);
    if (literals.has(want)) {
      if (input.expectationIndependent) confirmingIds.push(expectation.id);
    } else if (literals.size > 0) {
      contestIds.push(expectation.id);
    }
  }

  for (const defect of defects) {
    const want = normalizeLiteral(defect.expectedLiteral);
    const rejected = defect.rejectedLiteral
      ? normalizeLiteral(defect.rejectedLiteral)
      : undefined;
    const inputPresent = containsLiteral(combined, normalizeLiteral(defect.inputLiteral));
    if (literals.has(want)) {
      if (input.defectIndependent) confirmingIds.push(defect.id);
      continue;
    }
    if ((rejected && literals.has(rejected)) || (inputPresent && literals.size > 0)) {
      contestIds.push(defect.id);
      continue;
    }
    if (!inputPresent) missedIds.push(defect.id);
  }

  const contested = contestIds.length > 0;
  const missedBoundary = !contested && missedIds.length > 0;
  const hint = defects.find((record) => missedIds.includes(record.id)) ?? expectations[0];

  return {
    contested,
    contestIds,
    independentlyConfirmed: !contested && confirmingIds.length > 0,
    confirmingIds,
    missedBoundary,
    missedIds,
    ...(hint ? { confirmedExpectedLiteral: hint.expectedLiteral } : {}),
  };
}

export async function assessSymbolOracle(input: {
  rootDir: string;
  file: string;
  symbol: string;
  testFiles: string[];
  bundle: OracleBundle;
  sourceCommit: string | null;
}): Promise<SymbolOracleVerdict> {
  const testSources: string[] = [];
  for (const testFile of input.testFiles) {
    try {
      testSources.push(await fs.readFile(path.join(input.rootDir, testFile), "utf8"));
    } catch {
      testSources.push("");
    }
  }
  const expectationIndependent =
    input.sourceCommit !== null &&
    input.bundle.expectationCommit !== null &&
    input.sourceCommit !== input.bundle.expectationCommit;
  const defectIndependent =
    input.sourceCommit !== null &&
    input.bundle.defectCommit !== null &&
    input.sourceCommit !== input.bundle.defectCommit;
  return judgeSymbolOracle({
    file: input.file,
    symbol: input.symbol,
    testSources,
    expectations: input.bundle.expectations,
    defects: input.bundle.defects,
    expectationIndependent,
    defectIndependent,
  });
}

function extractAssertedLiterals(symbol: string, source: string): string[] {
  const escaped = escapeRegExp(symbol);
  const patterns = [
    new RegExp(
      `expect\\s*\\(\\s*${escaped}\\s*\\([^)]*\\)\\s*\\)\\s*\\.\\s*(?:toBe|toEqual|toStrictEqual)\\s*\\(\\s*([^)]+?)\\s*\\)`,
      "g",
    ),
    new RegExp(
      `assert(?:Equals|Equal)\\s*\\(\\s*([^,]+?)\\s*,\\s*${escaped}\\s*\\(`,
      "g",
    ),
    new RegExp(
      `assert_eq!\\s*\\(\\s*${escaped}\\s*\\([^)]*\\)\\s*,\\s*([^)]+?)\\s*\\)`,
      "g",
    ),
    new RegExp(`${escaped}\\s*\\([^)]*\\)\\s*!=\\s*([^\\n);]+)`, "g"),
  ];
  const literals: string[] = [];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const raw = match[1];
      if (raw) literals.push(normalizeLiteral(raw));
    }
  }
  return literals;
}

function containsLiteral(source: string, literal: string): boolean {
  if (!literal) return false;
  return new RegExp(`(?:^|[^\\w.])${escapeRegExp(literal)}(?:$|[^\\w])`).test(source);
}

function normalizeLiteral(raw: string): string {
  return raw.trim().replace(/^['"`]|['"`]$/g, "");
}

function samePath(a: string, b: string): boolean {
  const norm = (value: string) => value.replace(/\\/g, "/").replace(/^\.\//, "");
  return norm(a) === norm(b);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function resolveManifest(
  rootDir: string,
  explicit: string | undefined,
  fallback: string,
): Promise<{ abs: string; rel: string } | null> {
  if (explicit) {
    const abs = path.resolve(rootDir, explicit);
    try {
      await fs.access(abs);
    } catch {
      throw new Error(`Oracle manifest not found: ${explicit}`);
    }
    return { abs, rel: toPosix(path.relative(rootDir, abs)) };
  }
  const abs = path.join(rootDir, fallback);
  try {
    await fs.access(abs);
  } catch {
    return null;
  }
  return { abs, rel: fallback };
}

function parseExpectations(raw: string, relPath: string): ExpectationRecord[] {
  const parsed = parseJsonObject(raw, relPath);
  const rows = Array.isArray(parsed.expectations) ? parsed.expectations : [];
  return rows.map((row) => ({
    id: requireString(row, "id", relPath),
    file: requireString(row, "file", relPath),
    symbol: requireString(row, "symbol", relPath),
    expectedLiteral: requireString(row, "expectedLiteral", relPath),
  }));
}

function parseDefects(raw: string, relPath: string): DefectRecord[] {
  const parsed = parseJsonObject(raw, relPath);
  const rows = Array.isArray(parsed.defects) ? parsed.defects : [];
  return rows.map((row) => {
    const record: DefectRecord = {
      id: requireString(row, "id", relPath),
      file: requireString(row, "file", relPath),
      symbol: requireString(row, "symbol", relPath),
      inputLiteral: requireString(row, "inputLiteral", relPath),
      expectedLiteral: requireString(row, "expectedLiteral", relPath),
    };
    if (typeof row.rejectedLiteral === "string" && row.rejectedLiteral.trim()) {
      record.rejectedLiteral = row.rejectedLiteral;
    }
    return record;
  });
}

function parseJsonObject(raw: string, relPath: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Oracle manifest is not valid JSON: ${relPath}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Oracle manifest must be a JSON object: ${relPath}`);
  }
  return parsed as Record<string, unknown>;
}

function requireString(row: unknown, key: string, relPath: string): string {
  if (!row || typeof row !== "object") {
    throw new Error(`Invalid oracle manifest ${relPath}: entry is not an object`);
  }
  const value = (row as Record<string, unknown>)[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid oracle manifest ${relPath}: entry missing ${key}`);
  }
  return value;
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}
