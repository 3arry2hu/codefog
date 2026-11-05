import * as fs from "node:fs/promises";
import * as path from "node:path";
import { walkRepoFiles } from "./polyglot.js";
import type { DocBlockKind } from "./types.js";

export interface DocBlock {
  kind: DocBlockKind;
  startLine: number;
  endLine: number;
  rawText: string;
  normalizedText: string;
  ignored: boolean;
  language?: string;
  codeContent?: string;
  headingSlug?: string;
}

export interface ParsedDocFile {
  file: string;
  content: string;
  lines: string[];
  ignoredFile: boolean;
  headings: Array<{ text: string; slug: string; line: number }>;
  blocks: DocBlock[];
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

export function isInstructionFile(relPath: string): boolean {
  const norm = toPosix(relPath);
  const base = path.posix.basename(norm);
  if (base === "AGENTS.md" || base === "CLAUDE.md") return true;
  if (norm === ".github/copilot-instructions.md") return true;
  if (norm.startsWith(".cursor/rules/")) return true;
  if (/^(?:.*\/)?skills\/.*\/SKILL\.md$/.test(norm) || norm === "skills/SKILL.md") {
    return true;
  }
  return false;
}

export function slugifyMarkdownHeading(rawHeading: string): string {
  const cleaned = rawHeading
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_~]/g, "")
    .trim()
    .toLowerCase();
  return cleaned
    .replace(/[^\p{L}\p{N}\s\-_]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

export async function collectFilesUnderDir(
  dirAbs: string,
  rootDir: string,
  predicate: (relPath: string, entryName: string) => boolean,
  out: Set<string>,
): Promise<void> {
  await walkRepoFiles(dirAbs, rootDir, (relPath, entryName) => {
    if (predicate(relPath, entryName)) {
      out.add(relPath);
    }
  });
}

export async function discoverDocFiles(rootDir: string): Promise<string[]> {
  const found = new Set<string>();

  // 1. Root-level .md files (includes README.md, GLOSSARY.md, AGENTS.md, CLAUDE.md, etc.)
  try {
    const rootEntries = await fs.readdir(rootDir, { withFileTypes: true });
    for (const entry of rootEntries) {
      if (
        entry.isFile() &&
        (entry.name.toLowerCase().endsWith(".md") ||
          entry.name === "AGENTS.md" ||
          entry.name === "CLAUDE.md")
      ) {
        found.add(entry.name);
      }
    }
  } catch {
    // ignore
  }

  // 2. docs/** and adr/**
  await collectFilesUnderDir(
    path.join(rootDir, "docs"),
    rootDir,
    (_rel, name) => name.toLowerCase().endsWith(".md"),
    found,
  );
  await collectFilesUnderDir(
    path.join(rootDir, "adr"),
    rootDir,
    (_rel, name) => name.toLowerCase().endsWith(".md"),
    found,
  );

  // 3. .cursor/rules/*
  await collectFilesUnderDir(
    path.join(rootDir, ".cursor", "rules"),
    rootDir,
    (_rel, name) => !name.startsWith("."),
    found,
  );

  // 4. .github/copilot-instructions.md
  try {
    const copilotPath = path.join(rootDir, ".github", "copilot-instructions.md");
    const st = await fs.stat(copilotPath);
    if (st.isFile()) {
      found.add(".github/copilot-instructions.md");
    }
  } catch {
    // optional
  }

  // 5. skills/**/SKILL.md
  await collectFilesUnderDir(
    path.join(rootDir, "skills"),
    rootDir,
    (_rel, name) => name === "SKILL.md" || name.toLowerCase().endsWith(".md"),
    found,
  );

  return Array.from(found).sort((a, b) => a.localeCompare(b));
}

function isTableSeparatorLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|") || !trimmed.includes("-")) return false;
  const cells = trimmed
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

function isTableLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length > 1;
}

function isHorizontalRule(line: string): boolean {
  return /^\s*(?:-\s*-\s*-[-\s]*|\*\s*\*\s*\*[\*\s]*|_\s*_\s*_[_\s]*)$/.test(line);
}

export function parseMarkdownDoc(file: string, content: string): ParsedDocFile {
  const lines = content.split(/\r?\n/);
  const blocks: DocBlock[] = [];
  const headings: Array<{ text: string; slug: string; line: number }> = [];
  const slugCounts = new Map<string, number>();

  let ignoredFile = false;
  let ignoreNextBlock = false;
  let ignoreCurrentTable = false;

  // First pass: check if <!-- codefog-ignore-file --> exists outside fenced code blocks
  let inFenceScan = false;
  let fenceMarkerScan = "";
  for (const line of lines) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]![0]!;
      if (!inFenceScan) {
        inFenceScan = true;
        fenceMarkerScan = marker;
      } else if (marker === fenceMarkerScan) {
        inFenceScan = false;
        fenceMarkerScan = "";
      }
      continue;
    }
    if (!inFenceScan) {
      const withoutInlineCode = line.replace(/`[^`]*`/g, "");
      if (/<!--\s*codefog-ignore-file\s*-->/i.test(withoutInlineCode)) {
        ignoredFile = true;
      }
    }
  }

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const lineNum = i + 1;
    const trimmed = line.trim();

    if (trimmed === "") {
      ignoreCurrentTable = false;
      i++;
      continue;
    }

    // Standalone HTML comment
    const withoutInline = trimmed.replace(/`[^`]*`/g, "");
    if (/^<!--[\s\S]*-->$/.test(trimmed)) {
      if (/<!--\s*codefog-ignore-next\s*-->/i.test(withoutInline)) {
        ignoreNextBlock = true;
      }
      i++;
      continue;
    }

    // Fenced code block
    const fenceOpen = /^\s*(`{3,}|~{3,})([^\n]*)$/.exec(line);
    if (fenceOpen) {
      ignoreCurrentTable = false;
      const fenceChars = fenceOpen[1]!;
      const fenceChar = fenceChars[0]!;
      const fenceLen = fenceChars.length;
      const infoString = (fenceOpen[2] ?? "").trim();
      const language = infoString.split(/\s+/)[0]?.toLowerCase() ?? "";
      const startLine = lineNum;
      const codeLines: string[] = [];
      const rawLines: string[] = [line];
      i++;
      while (i < lines.length) {
        const curLine = lines[i]!;
        rawLines.push(curLine);
        const closeMatch = new RegExp(`^\\s*${fenceChar}{${fenceLen},}\\s*$`).exec(curLine);
        if (closeMatch) {
          i++;
          break;
        }
        codeLines.push(curLine);
        i++;
      }
      const endLine = i;
      const rawText = rawLines.join("\n");
      const blockIgnored = ignoredFile || ignoreNextBlock;
      ignoreNextBlock = false;
      blocks.push({
        kind: "code-block",
        startLine,
        endLine,
        rawText,
        normalizedText: rawText.replace(/\s+/g, ""),
        ignored: blockIgnored,
        language,
        codeContent: codeLines.join("\n"),
      });
      continue;
    }

    if (isHorizontalRule(line)) {
      ignoreCurrentTable = false;
      i++;
      continue;
    }

    // Heading
    const headingMatch = /^\s*(#{1,6})\s+(.+?)\s*#*$/.exec(line);
    if (headingMatch) {
      ignoreCurrentTable = false;
      const headingText = headingMatch[2]!.trim();
      const baseSlug = slugifyMarkdownHeading(headingText);
      const count = slugCounts.get(baseSlug) ?? 0;
      slugCounts.set(baseSlug, count + 1);
      const slug = count === 0 ? baseSlug : `${baseSlug}-${count}`;
      headings.push({ text: headingText, slug, line: lineNum });
      if (count > 0) {
        headings.push({ text: headingText, slug: baseSlug, line: lineNum });
      }
      const blockIgnored = ignoredFile || ignoreNextBlock;
      ignoreNextBlock = false;
      blocks.push({
        kind: "heading",
        startLine: lineNum,
        endLine: lineNum,
        rawText: line,
        normalizedText: line.replace(/\s+/g, ""),
        ignored: blockIgnored,
        headingSlug: slug,
      });
      i++;
      continue;
    }

    // Table row
    if (isTableLine(line)) {
      if (isTableSeparatorLine(line)) {
        i++;
        continue;
      }
      const nextLine = lines[i + 1];
      const isHeaderRow = nextLine !== undefined && isTableSeparatorLine(nextLine);
      if (isHeaderRow && ignoreNextBlock) {
        ignoreCurrentTable = true;
      }
      const blockIgnored = ignoredFile || ignoreNextBlock || ignoreCurrentTable;
      ignoreNextBlock = false;
      blocks.push({
        kind: "table-row",
        startLine: lineNum,
        endLine: lineNum,
        rawText: line,
        normalizedText: line.replace(/\s+/g, ""),
        ignored: blockIgnored,
      });
      i++;
      continue;
    }
    ignoreCurrentTable = false;

    // List item
    const listMatch = /^(\s*)(?:[-*+]|\d+[.)])\s+/.exec(line);
    if (listMatch) {
      const startLine = lineNum;
      const itemLines: string[] = [line];
      const blockIgnored = ignoredFile || ignoreNextBlock;
      ignoreNextBlock = false;
      i++;
      while (i < lines.length) {
        const nextL = lines[i]!;
        const nextTrim = nextL.trim();
        if (
          nextTrim === "" ||
          /^<!--[\s\S]*-->$/.test(nextTrim) ||
          /^\s*(`{3,}|~{3,})/.test(nextL) ||
          /^\s*#{1,6}\s+/.test(nextL) ||
          isTableLine(nextL) ||
          isHorizontalRule(nextL) ||
          /^\s*(?:[-*+]|\d+[.)])\s+/.test(nextL)
        ) {
          break;
        }
        if (/^\s{2,}|\t/.test(nextL)) {
          itemLines.push(nextL);
          i++;
        } else {
          break;
        }
      }
      const rawText = itemLines.join("\n");
      blocks.push({
        kind: "list-item",
        startLine,
        endLine: startLine + itemLines.length - 1,
        rawText,
        normalizedText: rawText.replace(/\s+/g, ""),
        ignored: blockIgnored,
      });
      continue;
    }

    // Paragraph
    const startLine = lineNum;
    const paraLines: string[] = [line];
    const blockIgnored = ignoredFile || ignoreNextBlock;
    ignoreNextBlock = false;
    i++;
    while (i < lines.length) {
      const nextL = lines[i]!;
      const nextTrim = nextL.trim();
      if (
        nextTrim === "" ||
        /^<!--[\s\S]*-->$/.test(nextTrim) ||
        /^\s*(`{3,}|~{3,})/.test(nextL) ||
        /^\s*#{1,6}\s+/.test(nextL) ||
        isTableLine(nextL) ||
        isHorizontalRule(nextL) ||
        /^\s*(?:[-*+]|\d+[.)])\s+/.test(nextL)
      ) {
        break;
      }
      paraLines.push(nextL);
      i++;
    }
    const rawText = paraLines.join("\n");
    blocks.push({
      kind: "paragraph",
      startLine,
      endLine: startLine + paraLines.length - 1,
      rawText,
      normalizedText: rawText.replace(/\s+/g, ""),
      ignored: blockIgnored,
    });
  }

  return {
    file,
    content,
    lines,
    ignoredFile,
    headings,
    blocks,
  };
}
