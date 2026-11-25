import { execFile } from "node:child_process";
import { posix } from "node:path";
import { promisify } from "node:util";
import { getLanguageAdapter } from "./adapters/index.js";
import { stripCommentsAndMaskStrings, type SupportedLanguageId } from "./adapters/shared.js";
import { HIGH_COGNITIVE_COMPLEXITY } from "./scoring.js";
import type { FileSummary, StructuralRotDelta } from "./types.js";

const execFileAsync = promisify(execFile);
const MIN_BLOCK_LINES = 6;

type ErrorPattern = StructuralRotDelta["addedErrorMasking"][number]["pattern"];

type DiffHunk = { start: number; oldCount: number; newCount: number };
interface SymbolStructure {
  symbol: string;
  line: number;
  complexity: number;
  masking: Array<{ line: number; pattern: ErrorPattern }>;
}

async function readChangedHunks(
  rootDir: string,
  baseRef: string,
  changedFiles: ReadonlySet<string>,
): Promise<Map<string, DiffHunk[]>> {
  const changed = new Map<string, DiffHunk[]>();
  const pathspecs = [...new Set([...changedFiles].map((file) => "*" + posix.extname(file)))];
  let patch: string;
  try {
    ({ stdout: patch } = await execFileAsync("git", [
      "-c", "core.quotePath=false", "diff", "--no-renames", "--no-color", "--no-ext-diff", "--no-textconv",
      "--text", "--unified=0", "--inter-hunk-context=0", "--src-prefix=a/", "--dst-prefix=b/",
      "--end-of-options", baseRef, "--", ...pathspecs,
    ], { cwd: rootDir, maxBuffer: 24 * 1024 * 1024 }));
  } catch {
    return changed;
  }

  let hunks: DiffHunk[] | undefined;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      hunks = undefined;
      inHunk = false;
    } else if (!inHunk && line.startsWith("+++ ")) {
      const raw = line.slice(4).replace(/\t$/, "");
      let target = raw;
      if (raw.startsWith('"')) {
        try {
          target = JSON.parse(raw) as string;
        } catch {
          continue;
        }
      }
      if (!target.startsWith("b/")) continue;
      hunks = [];
      changed.set(target.slice(2), hunks);
    } else if (line.startsWith("@@ ")) {
      inHunk = true;
      const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!hunk || !hunks) continue;
      hunks.push({
        start: Number(hunk[2]),
        oldCount: Number(hunk[1] ?? 1),
        newCount: Number(hunk[3] ?? 1),
      });
    }
  }
  return changed;
}

function intersects(hunks: DiffHunk[] | undefined, start: number, end: number): boolean {
  return !hunks || hunks.some((hunk) => {
    // A deletion can create a duplicate by joining previously separated lines.
    const hunkEnd = hunk.start + (hunk.newCount === 0 ? 1 : hunk.newCount - 1);
    return hunk.start <= end && start <= hunkEnd;
  });
}

function getBaselineLine(hunks: DiffHunk[] | undefined, line: number): number | undefined {
  if (!hunks) return undefined;
  let offset = 0;
  for (const { start, oldCount, newCount } of hunks) {
    if (line < start || (line === start && newCount === 0)) break;
    if (line < start + newCount) return undefined;
    offset += oldCount - newCount;
  }
  return line + offset;
}

function errorPattern(language: SupportedLanguageId, line: string): ErrorPattern {
  if (language === "go") return /\bif\s+err\s*!=\s*nil\b/.test(line) ? "empty-error-check" : "discarded-error";
  if (language === "rust") return /\.\s*expect\b/.test(line) ? "expect" : "unwrap";
  return "empty-catch";
}

function scanStructure(file: string, source: string): Map<string, SymbolStructure> {
  const adapter = getLanguageAdapter(file);
  if (!adapter || !adapter.isSourceFile(file) || adapter.isTestFile(file) || !source) return new Map();

  const lines = stripCommentsAndMaskStrings(source).masked.split("\n");
  const found = new Map<string, SymbolStructure>();
  const ordinals = new Map<string, number>();
  const spans = adapter.extractFunctionSpans(source, file);
  const regions = spans.length > 0 ? spans : [{ name: file, startLine: 1, endLine: lines.length }];
  for (const span of regions) {
    const metrics = adapter.analyzeFunctionStructure(source, span, file);
    const ordinal = ordinals.get(span.name) ?? 0;
    ordinals.set(span.name, ordinal + 1);
    found.set(`${span.name}\0${ordinal}`, {
      symbol: span.name,
      line: span.startLine,
      complexity: metrics.cognitiveComplexity,
      masking: metrics.errorMaskingLines.map((line) => ({
        line,
        pattern: errorPattern(adapter.id, lines[line - 1] ?? ""),
      })),
    });
  }
  return found;
}

function findNewErrorMasking(
  file: string,
  before: ReadonlyMap<string, SymbolStructure>,
  after: ReadonlyMap<string, SymbolStructure>,
  hunks: DiffHunk[] | undefined,
): StructuralRotDelta["addedErrorMasking"] {
  const previousCounts = new Map<string, number>();
  const previousByLine = new Map<string, string>();
  for (const [symbol, region] of before) {
    for (const { line, pattern } of region.masking) {
      const location = line + ":" + pattern;
      if (previousByLine.has(location)) continue;
      const key = symbol + "\0" + pattern;
      previousByLine.set(location, key);
      previousCounts.set(key, (previousCounts.get(key) ?? 0) + 1);
    }
  }

  const remaining: Array<{ key: string; line: number; pattern: ErrorPattern }> = [];
  const seen = new Set<string>();
  for (const [symbol, region] of after) {
    for (const { line, pattern } of region.masking) {
      const location = line + ":" + pattern;
      if (seen.has(location)) continue;
      seen.add(location);
      const oldKey = previousByLine.get(getBaselineLine(hunks, line) + ":" + pattern);
      if (oldKey) previousCounts.set(oldKey, previousCounts.get(oldKey)! - 1);
      else remaining.push({ key: symbol + "\0" + pattern, line, pattern });
    }
  }

  const added: StructuralRotDelta["addedErrorMasking"] = [];
  for (const { key, line, pattern } of remaining) {
    const previousCount = previousCounts.get(key) ?? 0;
    if (previousCount > 0) previousCounts.set(key, previousCount - 1);
    else added.push({ file, line, pattern });
  }
  return added;
}

interface CodeLine {
  line: number;
  normalized: string;
}

function normalizeCodeLines(source: string): CodeLine[] {
  const { noComments, masked } = stripCommentsAndMaskStrings(source);
  const lines = noComments.split("\n");
  const maskedLines = masked.split("\n");
  const code: CodeLine[] = [];
  const word = /[\p{L}\p{N}_$]/u;
  const whitespace = /\s/;
  let quote: string | undefined;
  let escaped = false;
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row]!;
    const maskedLine = maskedLines[row]!;
    let normalized = "";
    let pendingSpace = false;
    for (let col = 0; col < line.length; col++) {
      const char = line[col]!;
      if (quote) {
        normalized += char;
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === quote) quote = undefined;
        continue;
      }
      if (whitespace.test(char)) {
        pendingSpace = true;
        continue;
      }
      // Preserve the contents of literals and word boundaries while ignoring layout.
      if (pendingSpace && word.test(char) && word.test(normalized.at(-1) ?? "")) normalized += " ";
      pendingSpace = false;
      normalized += char;
      if ((char === '"' || char === "'" || char === "`") && char !== maskedLine[col]) quote = char;
    }
    if (normalized) code.push({ line: row + 1, normalized });
  }
  return code;
}

interface BlockOccurrence {
  file: string;
  lines: CodeLine[];
  offset: number;
  changed: boolean;
}

function indexBlocks(
  files: ReadonlyMap<string, string>,
  changedFiles: ReadonlySet<string>,
  changedHunks: ReadonlyMap<string, DiffHunk[]>,
): Map<string, BlockOccurrence[]> {
  const blocks = new Map<string, BlockOccurrence[]>();
  for (const [file, source] of files) {
    const lines = normalizeCodeLines(source);
    for (let offset = 0; offset <= lines.length - MIN_BLOCK_LINES; offset++) {
      const code = lines.slice(offset, offset + MIN_BLOCK_LINES).map((line) => line.normalized);
      if (!code.some((line) => /[\p{L}\p{N}]/u.test(line))) continue;
      const key = code.join("\n");
      const occurrences = blocks.get(key) ?? [];
      const previous = occurrences.at(-1);
      if (previous?.file === file && offset < previous.offset + MIN_BLOCK_LINES) continue;
      const start = lines[offset]!.line;
      const end = lines[offset + MIN_BLOCK_LINES - 1]!.line;
      const changed = changedFiles.has(file) && intersects(changedHunks.get(file), start, end);
      occurrences.push({ file, lines, offset, changed });
      blocks.set(key, occurrences);
    }
  }
  return blocks;
}

function findAddedDuplicateBlocks(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
  changedFiles: ReadonlySet<string>,
  changedHunks: ReadonlyMap<string, DiffHunk[]>,
): StructuralRotDelta["addedDuplicatedBlocks"] {
  const oldBlocks = indexBlocks(before, new Set(), new Map());
  const newBlocks = indexBlocks(after, changedFiles, changedHunks);
  const byAlignment = new Map<string, Array<{ added: BlockOccurrence; original: BlockOccurrence }>>();

  for (const [key, occurrences] of newBlocks) {
    const netNew = occurrences.length - Math.max(1, oldBlocks.get(key)?.length ?? 0);
    if (netNew <= 0) continue;
    const added = occurrences.filter((occurrence) => occurrence.changed).slice(-netNew);
    if (added.length === 0) continue;
    const original = occurrences.find((occurrence) => !added.includes(occurrence))!;
    for (const occurrence of added) {
      const alignment = JSON.stringify([occurrence.file, original.file, occurrence.offset - original.offset]);
      const windows = byAlignment.get(alignment) ?? [];
      windows.push({ added: occurrence, original });
      byAlignment.set(alignment, windows);
    }
  }

  const result: StructuralRotDelta["addedDuplicatedBlocks"] = [];
  for (const windows of byAlignment.values()) {
    windows.sort((a, b) => a.added.offset - b.added.offset);
    let active: StructuralRotDelta["addedDuplicatedBlocks"][number] | undefined;
    let endOffset = -1;
    for (const { added, original } of windows) {
      const end = added.offset + MIN_BLOCK_LINES - 1;
      const endLine = added.lines[end]!.line;
      const duplicateEndLine = original.lines[original.offset + MIN_BLOCK_LINES - 1]!.line;
      if (active && added.offset <= endOffset + 1) {
        active.endLine = endLine;
        active.duplicateEndLine = duplicateEndLine;
      } else {
        active = {
          file: added.file,
          startLine: added.lines[added.offset]!.line,
          endLine,
          duplicateFile: original.file,
          duplicateStartLine: original.lines[original.offset]!.line,
          duplicateEndLine,
        };
        result.push(active);
      }
      endOffset = end;
    }
  }
  return result.sort((a, b) => a.file.localeCompare(b.file) || a.startLine - b.startLine || a.endLine - b.endLine);
}

function productionSources(files: FileSummary[]): Map<string, string> {
  const sources = new Map<string, string>();
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const adapter = getLanguageAdapter(file.path);
    if (adapter?.isSourceFile(file.path) && !adapter.isTestFile(file.path)) {
      sources.set(file.path, file.lines.join("\n"));
    }
  }
  return sources;
}

export async function compareStructuralRot(
  rootDir: string,
  baseRef: string,
  baseline: FileSummary[],
  current: FileSummary[],
): Promise<StructuralRotDelta> {
  const before = productionSources(baseline);
  const after = productionSources(current);
  const changedFiles = new Set([...after.keys()].filter((file) => before.get(file) !== after.get(file)));
  const complexitySpikes: StructuralRotDelta["complexitySpikes"] = [];
  const addedErrorMasking: StructuralRotDelta["addedErrorMasking"] = [];
  if (changedFiles.size === 0) return { complexitySpikes, addedErrorMasking, addedDuplicatedBlocks: [] };

  const changedHunks = await readChangedHunks(rootDir, baseRef, changedFiles);
  for (const file of changedFiles) {
    const prior = scanStructure(file, before.get(file) ?? "");
    const latest = scanStructure(file, after.get(file)!);
    for (const [key, region] of latest) {
      const baselineComplexity = prior.get(key)?.complexity ?? 0;
      const delta = region.complexity - baselineComplexity;
      if (region.complexity > HIGH_COGNITIVE_COMPLEXITY && delta >= 10) {
        complexitySpikes.push({ file, symbol: region.symbol, line: region.line, before: baselineComplexity, after: region.complexity, delta });
      }
    }
    addedErrorMasking.push(...findNewErrorMasking(file, prior, latest, changedHunks.get(file)));
  }
  addedErrorMasking.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.pattern.localeCompare(b.pattern));
  return {
    complexitySpikes,
    addedErrorMasking,
    addedDuplicatedBlocks: findAddedDuplicateBlocks(before, after, changedFiles, changedHunks),
  };
}
