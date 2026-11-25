import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getLanguageAdapter } from "./adapters/index.js";
import { boundaryViolationKey, type ArchitectureContract } from "./architecture-contract.js";
import { CODEFOG_COMMAND } from "./cli-command.js";
import { listTrackedRepoFiles, readRecentCommitFiles } from "./git-freshness.js";
import { deriveModulePath, loadGitignoreMatchers, walkRepoFiles } from "./path-utils.js";
import { createDeterministicFindingId } from "./scoring.js";
import type {
  ArchitectureEdge,
  ArchitectureImport,
  ArchitectureSummary,
  BoundaryViolation,
  BoundaryViolationKey,
  FileSummary,
  Finding,
  ImplicitCoupling,
  UnstableHub,
} from "./types.js";

async function readSources(rootDir: string, snapshotFiles?: ReadonlySet<string>): Promise<{
  files: ReadonlySet<string>;
  sourceTexts: ReadonlyMap<string, string>;
}> {
  const [ignorePatterns, trackedFiles] = await Promise.all([
    loadGitignoreMatchers(rootDir),
    snapshotFiles ?? listTrackedRepoFiles(rootDir),
  ]);
  const files = new Set<string>();
  const sourceTexts = new Map<string, string>();
  await walkRepoFiles(rootDir, rootDir, async (file, name, absolutePath) => {
    if (!trackedFiles.has(file) && ignorePatterns.some((pattern) => pattern.test(file))) return;
    const adapter = getLanguageAdapter(file);
    const isProduction = adapter?.isSourceFile(file) && !adapter.isTestFile(file);
    if (!isProduction && name !== "go.mod" && name !== "Cargo.toml") return;
    sourceTexts.set(file, await fs.readFile(absolutePath, "utf8"));
    if (isProduction) files.add(file);
  });
  return { files, sourceTexts };
}

function moduleOf(file: string, contract?: ArchitectureContract): string {
  for (const [name, patterns] of contract?.modules ?? []) {
    if (patterns.some((pattern) => pattern.test(file))) return name;
  }
  // Standard Java layouts place many packages under the same source root.
  const fallback = deriveModulePath(file);
  return fallback === "src/main/java" ? path.posix.dirname(file) : fallback;
}

function edgeKey(from: string, to: string): string {
  return JSON.stringify([from, to]);
}

function stronglyConnectedComponents(graph: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  const indexByModule = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];

  function visit(module: string): void {
    const index = indexByModule.size;
    indexByModule.set(module, index);
    lowLink.set(module, index);
    stack.push(module);
    onStack.add(module);
    for (const target of graph.get(module)!) {
      if (!indexByModule.has(target)) {
        visit(target);
        lowLink.set(module, Math.min(lowLink.get(module)!, lowLink.get(target)!));
      } else if (onStack.has(target)) {
        lowLink.set(module, Math.min(lowLink.get(module)!, indexByModule.get(target)!));
      }
    }
    if (lowLink.get(module) !== index) return;
    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== module);
    if (component.length > 1) components.push(component.sort());
  }

  for (const module of graph.keys()) {
    if (!indexByModule.has(module)) visit(module);
  }
  return components.sort((a, b) => a[0]!.localeCompare(b[0]!));
}

function propagationCost(graph: ReadonlyMap<string, ReadonlySet<string>>): number {
  if (graph.size === 0) return 0;
  let reachablePairs = 0;
  for (const module of graph.keys()) {
    const reachable = new Set([module]);
    for (const current of reachable) {
      for (const target of graph.get(current)!) reachable.add(target);
    }
    reachablePairs += reachable.size;
  }
  return Math.round(1000 * reachablePairs / graph.size ** 2) / 10;
}

export async function analyzeArchitectureGraph(
  rootDir: string,
  contract?: ArchitectureContract,
  snapshotFiles?: ReadonlySet<string>,
) {
  const { files, sourceTexts } = await readSources(rootDir, snapshotFiles);
  const moduleByFile = new Map([...files].sort().map((file) => [file, moduleOf(file, contract)]));
  const modules = [...new Set(moduleByFile.values())].sort();
  const graph = new Map(modules.map((module) => [module, new Set<string>()]));
  const imports = new Map<string, ArchitectureImport>();
  const moduleImports = new Map<string, ArchitectureImport[]>();
  const moduleEdges: ArchitectureEdge[] = [];
  const boundaryViolations: BoundaryViolation[] = [];
  const rules = new Map(contract?.rules.map((rule) => [edgeKey(rule.from, rule.to), rule]));

  function addViolation(
    kind: BoundaryViolation["kind"],
    from: string,
    to: string,
    edges: ArchitectureImport[],
    reason: string,
    baselineKey: BoundaryViolationKey,
    explanation?: string,
  ): void {
    const baselined = contract?.baseline.has(boundaryViolationKey(baselineKey)) === true;
    boundaryViolations.push({
      kind, from, to, file: edges[0]!.from, reason, baselined, baselineKey, edges,
      ...(explanation ? { explanation } : {}),
    });
  }

  for (const [file, from] of moduleByFile) {
    const adapter = getLanguageAdapter(file)!;
    const edges = adapter.extractFileDependencies(sourceTexts.get(file)!, file, files, { sourceTexts });
    for (const edge of edges) {
      const to = moduleByFile.get(edge.to);
      if (to === undefined || edge.to === file) continue;
      const importKey = edgeKey(file, edge.to);
      if (imports.has(importKey)) continue;
      imports.set(importKey, edge);
      if (from === to) continue;
      const moduleKey = edgeKey(from, to);
      const edgesBetweenModules = moduleImports.get(moduleKey);
      if (edgesBetweenModules) {
        edgesBetweenModules.push(edge);
      } else {
        graph.get(from)!.add(to);
        moduleEdges.push({ from, to });
        moduleImports.set(moduleKey, [edge]);
      }
      const rule = rules.get(moduleKey);
      if ((rule?.effect ?? contract?.defaultPolicy) === "forbid") {
        const reason = rule?.because ?? "The Architecture Contract defaults to forbid.";
        addViolation(
          "rule", from, to, [edge],
          `${from} → ${to} (${file} → ${edge.to}): ${reason}`,
          { kind: "rule", from: file, to: edge.to },
          reason,
        );
      }
      const entries = contract?.publicEntry.get(to);
      if (entries && !entries.some((pattern) => pattern.test(edge.to))) {
        const reason = `Import bypasses the public entry points of ${to}.`;
        addViolation(
          "public-entry", from, to, [edge],
          `${from} → ${to} (${file} → ${edge.to}): ${reason}`,
          { kind: "public-entry", from: file, to: edge.to },
          reason,
        );
      }
    }
  }

  const cycles = stronglyConnectedComponents(graph).map((members) => {
    const memberSet = new Set(members);
    const edges = moduleEdges.filter((edge) => memberSet.has(edge.from) && memberSet.has(edge.to));
    const fileEdges = edges.flatMap(({ from, to }) => moduleImports.get(edgeKey(from, to))!);
    if (contract?.noCycles !== false) {
      const [first, ...rest] = members;
      const last = rest.length === 1 ? rest[0]! : JSON.stringify(rest);
      addViolation(
        "cycle", first!, last, fileEdges,
        `Module cycle involving ${members.join(", ")} (${edges.map(({ from, to }) => `${from} → ${to}`).join(", ")}).`,
        { kind: "cycle", from: first!, to: last },
      );
    }
    return { modules: members, edges, file: fileEdges[0]!.from };
  });

  return {
    moduleByFile,
    imports,
    sourceTexts,
    modules,
    edges: moduleEdges,
    propagationCostPct: propagationCost(graph),
    cycles,
    boundaryViolations,
  };
}

function findUnstableHubs(
  files: readonly FileSummary[],
  sourceCount: number,
  imports: ReadonlyMap<string, ArchitectureImport>,
): UnstableHub[] {
  const dependents = new Map<string, string[]>();
  for (const { from, to } of imports.values()) {
    const targets = dependents.get(to) ?? [];
    targets.push(from);
    dependents.set(to, targets);
  }

  const hubs: UnstableHub[] = [];
  for (const { path: file, churn90d, trustScore, locByState } of files) {
    const downstream = dependents.get(file) ?? [];
    const fanIn = downstream.length;
    const highFanIn = fanIn >= 5 || (fanIn >= 3 && fanIn >= sourceCount * 0.2);
    const hasFogReturned = locByState["fog-returned"] > 0;
    if (highFanIn && churn90d >= 3 && (trustScore < 60 || hasFogReturned)) {
      hubs.push({ file, fanIn, dependents: downstream.sort(), churn90d, trustScore, hasFogReturned });
    }
  }
  return hubs.sort((a, b) => b.fanIn - a.fanIn || b.churn90d - a.churn90d || a.file.localeCompare(b.file));
}

function findImplicitCouplings(
  commits: readonly string[][],
  moduleByFile: ReadonlyMap<string, string>,
  imports: ReadonlyMap<string, ArchitectureImport>,
): ImplicitCoupling[] {
  const changeCounts = new Map<string, number>();
  const pairs = new Map<string, ImplicitCoupling>();
  for (const changed of commits) {
    if (changed.length > 30) continue;
    const files = changed.filter((file) => moduleByFile.has(file)).sort();
    for (let i = 0; i < files.length; i++) {
      const from = files[i]!;
      changeCounts.set(from, (changeCounts.get(from) ?? 0) + 1);
      for (const to of files.slice(i + 1)) {
        if (moduleByFile.get(from) === moduleByFile.get(to)) continue;
        const key = edgeKey(from, to);
        if (imports.has(key) || imports.has(edgeKey(to, from))) continue;
        const pair = pairs.get(key);
        if (pair) pair.coChange++;
        else pairs.set(key, { from, to, coChange: 1, coupling: 0 });
      }
    }
  }

  const couplings: ImplicitCoupling[] = [];
  for (const pair of pairs.values()) {
    if (pair.coChange < 3) continue;
    const coupling = pair.coChange / Math.min(changeCounts.get(pair.from)!, changeCounts.get(pair.to)!);
    if (coupling >= 0.5) couplings.push({ ...pair, coupling });
  }
  return couplings.sort((a, b) => b.coChange - a.coChange || b.coupling - a.coupling ||
    a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

function architectureFinding(
  file: string,
  line: number,
  title: string,
  tags: string[],
  reason: string,
  action: string,
  identity: string,
): Finding {
  return {
    id: createDeterministicFindingId(file, identity),
    title,
    subjectType: "architecture",
    tags,
    state: "verified",
    riskScore: 0,
    agentReady: false,
    location: { file, symbol: title, startLine: line, endLine: line },
    reason,
    evidence: {
      executedByTests: 0,
      assertionsOnOutcome: 0,
      pseudoTested: false,
      oracleContest: false,
      oracleIds: [],
      missedBoundary: false,
      survivingMutants: [],
    },
    suggestedAction: action,
    acceptanceCheck: {
      command: `${CODEFOG_COMMAND} --arch --fail-on arch-violation`,
      criteria: [action],
    },
  };
}

export async function analyzeArchitecture(
  rootDir: string,
  files: readonly FileSummary[],
  architectureGraph: Awaited<ReturnType<typeof analyzeArchitectureGraph>>,
): Promise<{ summary: ArchitectureSummary; findings: Finding[]; warning?: string }> {
  const { moduleByFile, imports, sourceTexts, ...graph } = architectureGraph;
  const history = await readRecentCommitFiles(rootDir);
  const enoughHistory = !history.shallow && history.commits.length >= 10;
  const summary: ArchitectureSummary = {
    ...graph,
    unstableHubs: findUnstableHubs(files, moduleByFile.size, imports),
    implicitCouplings: enoughHistory ? findImplicitCouplings(history.commits, moduleByFile, imports) : [],
  };
  const reportedFiles = new Set(files.map((file) => file.path));
  const linkedFiles = new Set([
    ...graph.boundaryViolations.map((violation) => violation.file),
    ...graph.cycles.map((cycle) => cycle.file),
    ...summary.implicitCouplings.flatMap(({ from, to }) => [from, to]),
  ]);
  const architectureOnly = [...linkedFiles].filter((file) => !reportedFiles.has(file));
  if (architectureOnly.length > 0) {
    summary.sourceFiles = Object.fromEntries(
      architectureOnly.map((file) => [file, sourceTexts.get(file)!.split(/\r?\n/)]),
    );
  }

  const findings = [
    ...summary.boundaryViolations.map((violation) => ({
      ...architectureFinding(
        violation.file, violation.edges[0]!.line, "Boundary Violation",
        violation.kind === "cycle" ? ["arch-cycle", "boundary-violation"] : ["boundary-violation"],
        violation.reason, "Route dependencies through the permitted module boundary.",
        boundaryViolationKey(violation.baselineKey),
      ),
      baselined: violation.baselined,
      locations: violation.edges.map(({ from, to, line }) => ({
        file: from, symbol: to, startLine: line, endLine: line,
      })),
    })),
    ...summary.unstableHubs.map((hub) => architectureFinding(
      hub.file, 1, "Unstable Hub", ["unstable-hub"],
      `${hub.fanIn} dependent files, ${hub.churn90d} changes in 90 days, Trust Score ${hub.trustScore}/100${hub.hasFogReturned ? ", with Fog Returned" : ""}.`,
      "Review the dependent files and strengthen behavioral evidence before refactoring.",
      "unstable-hub",
    )),
    ...summary.implicitCouplings.map((pair) => architectureFinding(
      pair.from, 1, "Implicit Coupling", ["implicit-coupling"],
      `${pair.from} and ${pair.to} changed together in ${pair.coChange} commits (${Math.round(pair.coupling * 100)}% of the less-frequently changed file's commits).`,
      "Review why the two modules change together.",
      `implicit-coupling:${pair.to}`,
    )),
  ];

  return {
    summary,
    findings,
    warning: enoughHistory
      ? undefined
      : "Implicit Coupling requires at least 10 recent commits and a non-shallow clone. Git history is insufficient.",
  };
}
