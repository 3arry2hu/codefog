import * as fs from "node:fs/promises";
import * as path from "node:path";

export function toPosix(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

export function truncateMiddle(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  if (max <= 1) return "…";
  const head = Math.ceil((max - 1) / 2);
  const tail = max - 1 - head;
  return chars.slice(0, head).join("") + "…" + (tail > 0 ? chars.slice(-tail).join("") : "");
}

export const REPO_IGNORED_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "vendor",
  "dist",
  "coverage",
  ".codefog",
  "target",
  "build",
  ".idea",
  ".vscode",
  ".gradle",
]);

export function isIgnoredRepoDir(dirName: string): boolean {
  return REPO_IGNORED_DIRS.has(dirName);
}

export function isIgnoredRepoRelPath(relPath: string): boolean {
  return toPosix(relPath)
    .split("/")
    .some((seg) => REPO_IGNORED_DIRS.has(seg));
}

function globPatternToRegex(pattern: string): RegExp {
  let pat = pattern.trim();
  const anchored = pat.startsWith("/");
  if (anchored) pat = pat.slice(1);
  const dirOnly = pat.endsWith("/");
  if (dirOnly) pat = pat.slice(0, -1);

  const escaped = pat
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, ".*");

  if (dirOnly) {
    return anchored
      ? new RegExp(`^${escaped}(?:/.*)?$`)
      : new RegExp(`(?:^|/)${escaped}(?:/.*)?$`);
  }
  if (anchored || pat.includes("/")) {
    return new RegExp(`^${escaped}(?:/.*)?$`);
  }
  return new RegExp(`(?:^|/)${escaped}(?:/.*)?$`);
}

export async function loadGitignoreMatchers(rootDir: string): Promise<RegExp[]> {
  try {
    const raw = await fs.readFile(path.join(rootDir, ".gitignore"), "utf8");
    const matchers: RegExp[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) continue;
      matchers.push(globPatternToRegex(trimmed));
    }
    return matchers;
  } catch {
    return [];
  }
}

export async function walkRepoFiles(
  dirAbs: string,
  rootDir: string,
  onFile: (relPath: string, entryName: string, fullPath: string) => void | Promise<void>,
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dirAbs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (isIgnoredRepoDir(entry.name)) {
      continue;
    }
    const fullPath = path.join(dirAbs, entry.name);
    if (entry.isDirectory()) {
      await walkRepoFiles(fullPath, rootDir, onFile);
    } else if (entry.isFile()) {
      const relPath = toPosix(path.relative(rootDir, fullPath));
      await onFile(relPath, entry.name, fullPath);
    }
  }
}

export async function findFilesByExtensionInRepo(
  dir: string,
  rootDir: string,
  ext: string,
  out: string[] = [],
): Promise<string[]> {
  await walkRepoFiles(dir, rootDir, (relPath, entryName) => {
    if (entryName.endsWith(ext)) {
      out.push(relPath);
    }
  });
  return out;
}

export function deriveModulePath(filePath: string): string {
  const parts = filePath.split("/").filter(Boolean);
  if (parts.length >= 4 && parts[0] === "src" && parts[1] === "main" && parts[2] === "java") {
    return "src/main/java";
  }
  if (
    parts.length >= 3 &&
    (parts[0] === "src" ||
      parts[0] === "internal" ||
      parts[0] === "pkg" ||
      parts[0] === "cmd" ||
      parts[0] === "crates" ||
      parts[0] === "services")
  ) {
    return `${parts[0]}/${parts[1]}`;
  }
  if (parts.length >= 2) {
    return parts[0]!;
  }
  return ".";
}
