import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { BoundaryViolationKey } from "./types.js";

export const DEFAULT_ARCHITECTURE_CONFIG = ".codefog/architecture.json";

type Policy = "allow" | "forbid";

interface Rule {
  from: string;
  to: string;
  effect: Policy;
  because: string;
}

export interface ArchitectureContract {
  modules: Map<string, RegExp[]>;
  defaultPolicy: Policy;
  noCycles: boolean;
  rules: Rule[];
  publicEntry: Map<string, RegExp[]>;
  baseline: Set<string>;
}

export function boundaryViolationKey({ kind, from, to }: BoundaryViolationKey): string {
  return JSON.stringify([kind, from, to]);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPolicy(value: unknown): value is Policy {
  return value === "allow" || value === "forbid";
}

function isViolationKind(value: unknown): value is BoundaryViolationKey["kind"] {
  return value === "rule" || value === "cycle" || value === "public-entry";
}

function pathGlob(pattern: string): RegExp {
  const expression = pattern.trim().replace(/^\.?\//, "").replace(
    /\*\*\/|\*\*|\*|\?|[.+^${}()|[\]\\]/g,
    (token) => {
      switch (token) {
        case "**/": return "(?:.*/)?";
        case "**": return ".*";
        case "*": return "[^/]*";
        case "?": return "[^/]";
        default: return `\\${token}`;
      }
    },
  );
  return new RegExp(`^${expression}$`);
}

function readPathGroups(field: string, value: unknown): Map<string, RegExp[]> {
  if (value === undefined) return new Map();
  if (!isObject(value)) throw new Error(`${field} must map names to arrays of path globs`);
  const groups = new Map<string, RegExp[]>();
  for (const [name, patterns] of Object.entries(value)) {
    if (!isText(name) || !Array.isArray(patterns) || !patterns.every(isText)) {
      throw new Error(`${field}.${name} must be an array of non-empty path globs`);
    }
    groups.set(name, patterns.map(pathGlob));
  }
  return groups;
}

function readEntries<T>(
  field: string,
  value: unknown,
  parse: (entry: Record<string, unknown>) => T | undefined,
): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((entry, index) => {
    const parsed = isObject(entry) ? parse(entry) : undefined;
    if (!parsed) throw new Error(`${field}[${index}] has missing or invalid fields`);
    return parsed;
  });
}

export async function loadArchitectureContract(
  rootDir: string,
  explicitPath?: string,
): Promise<ArchitectureContract | undefined> {
  const configFile = path.resolve(rootDir, explicitPath ?? DEFAULT_ARCHITECTURE_CONFIG);
  let text: string;
  try {
    text = await fs.readFile(configFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (explicitPath === undefined) return undefined;
      throw new Error(`Architecture Contract file not found: ${configFile}`);
    }
    throw error;
  }

  try {
    const raw: unknown = JSON.parse(text);
    if (!isObject(raw)) throw new Error("expected a JSON object");
    const allowedFields = new Set(["modules", "defaultPolicy", "noCycles", "rules", "publicEntry", "baseline"]);
    for (const field of Object.keys(raw)) {
      if (!allowedFields.has(field)) throw new Error(`unknown field '${field}'`);
    }
    if (raw.defaultPolicy !== undefined && !isPolicy(raw.defaultPolicy)) {
      throw new Error('defaultPolicy must be "allow" or "forbid"');
    }
    if (raw.noCycles !== undefined && typeof raw.noCycles !== "boolean") {
      throw new Error("noCycles must be a boolean");
    }
    const rules = readEntries("rules", raw.rules, ({ from, to, effect, because }) =>
      isText(from) && isText(to) && isPolicy(effect) && isText(because)
        ? { from, to, effect, because }
        : undefined,
    );
    const baseline = readEntries("baseline", raw.baseline, ({ kind, from, to }) =>
      isViolationKind(kind) && isText(from) && isText(to)
        ? boundaryViolationKey({ kind, from, to })
        : undefined,
    );
    return {
      modules: readPathGroups("modules", raw.modules),
      defaultPolicy: raw.defaultPolicy ?? "allow",
      noCycles: raw.noCycles ?? true,
      rules,
      publicEntry: readPathGroups("publicEntry", raw.publicEntry),
      baseline: new Set(baseline),
    };
  } catch (error) {
    throw new Error(`Invalid Architecture Contract ${configFile}: ${(error as Error).message}`);
  }
}
