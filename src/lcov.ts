export interface LcovBranchEntry {
  line: number;
  block: number;
  branch: number;
  taken: number;
}

export interface LcovFunctionEntry {
  name: string;
  line: number;
  hits: number;
}

export interface LcovFileRecord {
  file: string;
  lines: Map<number, number>;
  branches: LcovBranchEntry[];
  functions: LcovFunctionEntry[];
  linesFound: number;
  linesHit: number;
  branchesFound: number;
  branchesHit: number;
}

export function normalizeRepoRelativePath(filePath: string, rootDir: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const normalizedRoot = rootDir.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalized.startsWith(normalizedRoot + "/")) {
    return normalized.slice(normalizedRoot.length + 1);
  }
  return normalized.replace(/^\.\//, "");
}

export function parseLcov(content: string, rootDir: string): Map<string, LcovFileRecord> {
  const records = new Map<string, LcovFileRecord>();
  let current: LcovFileRecord | null = null;
  let fnMap = new Map<string, LcovFunctionEntry>();

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("SF:")) {
      const rel = normalizeRepoRelativePath(line.slice(3).trim(), rootDir);
      current = records.get(rel) ?? {
        file: rel,
        lines: new Map<number, number>(),
        branches: [],
        functions: [],
        linesFound: 0,
        linesHit: 0,
        branchesFound: 0,
        branchesHit: 0,
      };
      fnMap = new Map(current.functions.map((f) => [f.name, f]));
      records.set(rel, current);
      continue;
    }

    if (!current) continue;

    if (line === "end_of_record") {
      current.linesFound = current.lines.size;
      current.linesHit = Array.from(current.lines.values()).filter((v) => v > 0).length;
      current.branchesFound = current.branches.length;
      current.branchesHit = current.branches.filter((b) => b.taken > 0).length;
      current = null;
      continue;
    }

    if (line.startsWith("FN:")) {
      const rest = line.slice(3);
      const commaIdx = rest.indexOf(",");
      if (commaIdx !== -1) {
        const lineNum = Number.parseInt(rest.slice(0, commaIdx), 10);
        const name = rest.slice(commaIdx + 1).trim();
        if (Number.isFinite(lineNum) && name && !fnMap.has(name)) {
          const entry: LcovFunctionEntry = { name, line: lineNum, hits: 0 };
          fnMap.set(name, entry);
          current.functions.push(entry);
        }
      }
      continue;
    }

    if (line.startsWith("FNDA:")) {
      const rest = line.slice(5);
      const commaIdx = rest.indexOf(",");
      if (commaIdx !== -1) {
        const hits = Number.parseInt(rest.slice(0, commaIdx), 10);
        const name = rest.slice(commaIdx + 1).trim();
        const existing = fnMap.get(name);
        if (existing && Number.isFinite(hits)) {
          existing.hits += hits;
        }
      }
      continue;
    }

    if (line.startsWith("DA:")) {
      const parts = line.slice(3).split(",");
      const lineNum = Number.parseInt(parts[0] ?? "", 10);
      const hits = Number.parseInt(parts[1] ?? "0", 10);
      if (Number.isFinite(lineNum) && Number.isFinite(hits)) {
        const prev = current.lines.get(lineNum) ?? 0;
        current.lines.set(lineNum, prev + Math.max(0, hits));
      }
      continue;
    }

    if (line.startsWith("BRDA:")) {
      const parts = line.slice(5).split(",");
      const lineNum = Number.parseInt(parts[0] ?? "", 10);
      const block = Number.parseInt(parts[1] ?? "0", 10);
      const branch = Number.parseInt(parts[2] ?? "0", 10);
      const takenRaw = (parts[3] ?? "-").trim();
      const taken = takenRaw === "-" ? 0 : Number.parseInt(takenRaw, 10) || 0;
      if (Number.isFinite(lineNum)) {
        current.branches.push({ line: lineNum, block, branch, taken });
      }
    }
  }

  return records;
}
