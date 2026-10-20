import * as fs from "node:fs/promises";
import * as path from "node:path";

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

export function normalizeRepoRelativePath(
  filePath: string,
  rootDir: string,
  goModulePrefix?: string,
): string {
  const normalized = filePath.replace(/\\/g, "/");
  const normalizedRoot = rootDir.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalized.startsWith(normalizedRoot + "/")) {
    return normalized.slice(normalizedRoot.length + 1);
  }
  if (goModulePrefix && normalized.startsWith(goModulePrefix + "/")) {
    return normalized.slice(goModulePrefix.length + 1);
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

export function parseGoCoverProfile(
  content: string,
  rootDir: string,
  goModulePrefix?: string,
): Map<string, LcovFileRecord> {
  const records = new Map<string, LcovFileRecord>();
  const lineRe = /^(.+):(\d+)\.(\d+),(\d+)\.(\d+)\s+(\d+)\s+(\d+)$/;
  let branchSeq = 0;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("mode:")) continue;

    const m = lineRe.exec(line);
    if (!m) continue;

    const rawFile = m[1]!;
    const startLine = Number.parseInt(m[2]!, 10);
    const endLine = Number.parseInt(m[4]!, 10);
    const count = Number.parseInt(m[7]!, 10);

    const rel = normalizeRepoRelativePath(rawFile, rootDir, goModulePrefix);
    let current = records.get(rel);
    if (!current) {
      current = {
        file: rel,
        lines: new Map<number, number>(),
        branches: [],
        functions: [],
        linesFound: 0,
        linesHit: 0,
        branchesFound: 0,
        branchesHit: 0,
      };
      records.set(rel, current);
    }

    for (let ln = startLine; ln <= endLine; ln++) {
      const prev = current.lines.get(ln) ?? 0;
      current.lines.set(ln, Math.max(prev, count));
    }

    current.branches.push({
      line: startLine,
      block: branchSeq,
      branch: branchSeq++,
      taken: count,
    });
  }

  for (const rec of records.values()) {
    rec.linesFound = rec.lines.size;
    rec.linesHit = Array.from(rec.lines.values()).filter((v) => v > 0).length;
    rec.branchesFound = rec.branches.length;
    rec.branchesHit = rec.branches.filter((b) => b.taken > 0).length;
  }

  return records;
}

async function findJavaSourceFilesInRepo(
  dir: string,
  rootDir: string,
  out: string[] = [],
): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (
      entry.name === "node_modules" ||
      entry.name === ".git" ||
      entry.name === "target" ||
      entry.name === "build" ||
      entry.name === "dist"
    ) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await findJavaSourceFilesInRepo(full, rootDir, out);
    } else if (entry.name.endsWith(".java")) {
      out.push(path.relative(rootDir, full).replace(/\\/g, "/"));
    }
  }
  return out;
}

export async function parseJacocoXml(
  content: string,
  rootDir: string,
): Promise<Map<string, LcovFileRecord>> {
  const records = new Map<string, LcovFileRecord>();
  const javaFiles = await findJavaSourceFilesInRepo(rootDir, rootDir);

  const pkgRe = /<package\s+name="([^"]*)"[^>]*>([\s\S]*?)<\/package>/g;
  let pm: RegExpExecArray | null;

  while ((pm = pkgRe.exec(content)) !== null) {
    const pkgName = pm[1]!.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    const pkgBody = pm[2]!;

    const sfRe = /<sourcefile\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/sourcefile>/g;
    let sfm: RegExpExecArray | null;

    while ((sfm = sfRe.exec(pkgBody)) !== null) {
      const fileName = sfm[1]!;
      const sfBody = sfm[2]!;
      const suffix = pkgName ? `${pkgName}/${fileName}` : fileName;

      // Match against scanned repo Java files (e.g. `src/main/java/com/acme/Order.java` or `services/ledger/src/main/java/com/acme/Ledger.java`)
      const matchedRel =
        javaFiles.find(
          (f) => f === suffix || f.endsWith(`/${suffix}`),
        ) ?? `src/main/java/${suffix}`;

      const record: LcovFileRecord = {
        file: matchedRel,
        lines: new Map<number, number>(),
        branches: [],
        functions: [],
        linesFound: 0,
        linesHit: 0,
        branchesFound: 0,
        branchesHit: 0,
      };

      const lineTagRe = /<line\s+([^/>]+)\/?>/g;
      let lm: RegExpExecArray | null;
      let branchBlock = 0;

      while ((lm = lineTagRe.exec(sfBody)) !== null) {
        const attrs = lm[1]!;
        const getAttr = (k: string): number => {
          const m = new RegExp(`\\b${k}="(\\d+)"`).exec(attrs);
          return m ? Number.parseInt(m[1]!, 10) : 0;
        };
        const nr = getAttr("nr");
        const ci = getAttr("ci");
        const mb = getAttr("mb");
        const cb = getAttr("cb");
        if (nr <= 0) continue;

        record.lines.set(nr, ci > 0 ? ci : 0);

        const totalBranches = mb + cb;
        if (totalBranches > 0) {
          for (let b = 0; b < cb; b++) {
            record.branches.push({
              line: nr,
              block: branchBlock,
              branch: b,
              taken: 1,
            });
          }
          for (let b = 0; b < mb; b++) {
            record.branches.push({
              line: nr,
              block: branchBlock,
              branch: cb + b,
              taken: 0,
            });
          }
          branchBlock++;
        }
      }

      record.linesFound = record.lines.size;
      record.linesHit = Array.from(record.lines.values()).filter((v) => v > 0).length;
      record.branchesFound = record.branches.length;
      record.branchesHit = record.branches.filter((b) => b.taken > 0).length;

      records.set(matchedRel, record);
    }
  }

  return records;
}

async function readGoModuleName(rootDir: string): Promise<string | undefined> {
  try {
    const goMod = await fs.readFile(path.join(rootDir, "go.mod"), "utf8");
    const m = /^\s*module\s+(\S+)/m.exec(goMod);
    return m?.[1];
  } catch {
    return undefined;
  }
}

export async function loadCoverageRecords(
  rootDir: string,
  explicitPaths?: string | string[],
): Promise<{ records: Map<string, LcovFileRecord>; mtimeMs?: number }> {
  const goModulePrefix = await readGoModuleName(rootDir);
  const candidateRelPaths: string[] = [];

  if (explicitPaths) {
    const rawItems = Array.isArray(explicitPaths) ? explicitPaths : [explicitPaths];
    for (const item of rawItems) {
      for (const p of item.split(",")) {
        if (p.trim()) candidateRelPaths.push(p.trim());
      }
    }
  }

  const resolvedPaths: string[] = [];
  if (candidateRelPaths.length > 0) {
    for (const p of candidateRelPaths) {
      resolvedPaths.push(path.resolve(rootDir, p));
    }
  } else {
    const defaults = [
      path.join(rootDir, "coverage", "lcov.info"),
      path.join(rootDir, "coverage.out"),
      path.join(rootDir, "target", "site", "jacoco", "jacoco.xml"),
      path.join(rootDir, "build", "reports", "jacoco", "test", "jacocoTestReport.xml"),
    ];
    for (const d of defaults) {
      try {
        await fs.access(d);
        resolvedPaths.push(d);
      } catch {
        // continue checking other default coverage paths
      }
    }
    if (resolvedPaths.length === 0) {
      throw new Error(
        `Could not read LCOV coverage file at ${path.join(rootDir, "coverage", "lcov.info")}`,
      );
    }
  }

  const merged = new Map<string, LcovFileRecord>();
  let latestMtimeMs: number | undefined;

  for (const absPath of resolvedPaths) {
    let content = "";
    try {
      content = await fs.readFile(absPath, "utf8");
      const stat = await fs.stat(absPath);
      if (latestMtimeMs === undefined || stat.mtimeMs > latestMtimeMs) {
        latestMtimeMs = stat.mtimeMs;
      }
    } catch {
      throw new Error(`Could not read LCOV coverage file at ${absPath}`);
    }

    const trimmed = content.trimStart();
    let parsed: Map<string, LcovFileRecord>;
    if (trimmed.startsWith("mode:")) {
      parsed = parseGoCoverProfile(content, rootDir, goModulePrefix);
    } else if (trimmed.startsWith("<?xml") || trimmed.includes("<report")) {
      parsed = await parseJacocoXml(content, rootDir);
    } else {
      parsed = parseLcov(content, rootDir);
    }

    for (const [rel, rec] of parsed.entries()) {
      merged.set(rel, rec);
    }
  }

  return { records: merged, mtimeMs: latestMtimeMs };
}
