import { toPosix, walkRepoFiles } from "./path-utils.js";
import { getLanguageAdapter, LANGUAGE_ADAPTERS } from "./adapters/index.js";
import { createEvidenceAccumulator, stripCodeExtension, type PolyglotAstEvidenceEntry } from "./adapters/shared.js";

export { countTsJsOutcomeAssertions } from "./adapters/ts-evidence.js";

export interface FunctionAstEvidence {
  symbol: string;
  file: string;
  executedTestBlocks: number;
  assertionsOnOutcome: number;
  /** Count of shallow liveness checks (`toBeDefined`, `assertNotNull`, etc.) without outcome verification. */
  livenessChecksOnly: number;
  /** @deprecated Read `livenessChecksOnly` instead (`GLOSSARY.md` avoids "Weak Assertion"). */
  weakAssertionsOnly: number;
  testFiles: string[];
}

export interface RepoTestAstResult {
  testFileCount: number;
  /** Keyed by `${normalizedFilePath}::${symbol}` and fallback `*::${symbol}` */
  byFileAndSymbol: Map<string, FunctionAstEvidence>;
  bySymbol: Map<string, FunctionAstEvidence>;
}

async function scanRepoFiles(
  dir: string,
  rootDir: string,
  out: { testFiles: string[]; sourceFiles: string[] } = { testFiles: [], sourceFiles: [] },
): Promise<{ testFiles: string[]; sourceFiles: string[] }> {
  await walkRepoFiles(dir, rootDir, (relEntryPath) => {
    const adapter = getLanguageAdapter(relEntryPath);
    if (!adapter) return;
    const role = adapter.classifyEvidenceFile
      ? adapter.classifyEvidenceFile(relEntryPath)
      : adapter.isTestFile(relEntryPath) ? "test" : "source";
    if (role === "test") {
      out.testFiles.push(relEntryPath);
    } else if (role === "source") {
      out.sourceFiles.push(relEntryPath);
    }
  });
  return out;
}

export async function analyzeTestAstEvidence(rootDir: string): Promise<RepoTestAstResult> {
  const { testFiles, sourceFiles } = await scanRepoFiles(rootDir, rootDir);
  const { evidenceMap: internalMap, getOrCreateEv } = createEvidenceAccumulator();
  const bySymbolInternal = new Map<string, PolyglotAstEvidenceEntry>();

  function getOrCreateInternal(targetFileStem: string | null, symbol: string): PolyglotAstEvidenceEntry {
    const entry = getOrCreateEv(targetFileStem ?? "*", symbol);
    if (!bySymbolInternal.has(symbol)) {
      bySymbolInternal.set(symbol, entry);
    }
    return entry;
  }

  // Build static call graph across source files and propagate test & assertion evidence
  const callGraph = new Map<string, Set<string>>();

  for (const adapter of LANGUAGE_ADAPTERS) {
    const langSourceFiles = sourceFiles.filter((f) => getLanguageAdapter(f) === adapter);
    const langTestFiles = testFiles.filter((f) => getLanguageAdapter(f) === adapter);
    if (langSourceFiles.length === 0 && langTestFiles.length === 0) continue;

    const evidence = await adapter.analyzeAstEvidence(rootDir, langSourceFiles, langTestFiles);
    for (const ev of evidence.evidenceEntries) {
      const target = getOrCreateInternal(ev.fileStem, ev.symbol);
      for (const b of ev.executedBlocks) target.executedBlocks.add(b);
      for (const ob of ev.outcomeAssertedBlocks) target.outcomeAssertedBlocks.add(ob);
      for (const lb of ev.livenessCheckedBlocks) target.livenessCheckedBlocks.add(lb);
      target.directOutcomeAssertions += ev.directOutcomeAssertions;
      target.directLivenessChecks += ev.directLivenessChecks;
      for (const tf of ev.testFiles) target.testFiles.add(tf);
    }
    for (const [callerKey, edges] of evidence.callGraphEdges.entries()) {
      const existing = callGraph.get(callerKey) ?? new Set<string>();
      for (const edge of edges) existing.add(edge);
      callGraph.set(callerKey, existing);
    }
  }

  // Fixed-point propagation along callGraph edges
  let changed = true;
  let iterations = 0;
  while (changed && iterations < 20) {
    changed = false;
    iterations++;
    for (const [callerKey, callees] of callGraph.entries()) {
      const [callerStem, callerSym] = callerKey.split("::");
      const callerEv =
        internalMap.get(callerKey) ??
        internalMap.get(`*::${callerSym}`) ??
        (callerSym ? bySymbolInternal.get(callerSym) : undefined);

      if (!callerEv || callerEv.executedBlocks.size === 0) continue;

      for (const calleeKey of callees) {
        const [calleeStem, calleeSym] = calleeKey.split("::");
        if (!calleeSym) continue;
        const calleeEv = getOrCreateInternal(calleeStem ?? null, calleeSym);

        for (const blk of callerEv.executedBlocks) {
          if (!calleeEv.executedBlocks.has(blk)) {
            calleeEv.executedBlocks.add(blk);
            changed = true;
          }
        }
        for (const blk of callerEv.outcomeAssertedBlocks) {
          if (!calleeEv.outcomeAssertedBlocks.has(blk)) {
            calleeEv.outcomeAssertedBlocks.add(blk);
            changed = true;
          }
        }
        for (const blk of callerEv.livenessCheckedBlocks) {
          if (!calleeEv.livenessCheckedBlocks.has(blk)) {
            calleeEv.livenessCheckedBlocks.add(blk);
            changed = true;
          }
        }
        for (const tf of callerEv.testFiles) {
          if (!calleeEv.testFiles.has(tf)) {
            calleeEv.testFiles.add(tf);
            changed = true;
          }
        }
      }
    }
  }

  const byFileAndSymbol = new Map<string, FunctionAstEvidence>();
  const bySymbol = new Map<string, FunctionAstEvidence>();

  for (const [key, internal] of internalMap.entries()) {
    const livenessCount = Math.max(
      internal.directLivenessChecks,
      internal.livenessCheckedBlocks.size,
    );
    const pub: FunctionAstEvidence = {
      symbol: internal.symbol,
      file: internal.fileStem,
      executedTestBlocks: internal.executedBlocks.size,
      assertionsOnOutcome: Math.max(
        internal.directOutcomeAssertions,
        internal.outcomeAssertedBlocks.size,
      ),
      livenessChecksOnly: livenessCount,
      weakAssertionsOnly: livenessCount,
      testFiles: Array.from(internal.testFiles),
    };
    byFileAndSymbol.set(key, pub);
    const existingBySym = bySymbol.get(internal.symbol);
    if (!existingBySym || pub.assertionsOnOutcome > existingBySym.assertionsOnOutcome) {
      bySymbol.set(internal.symbol, pub);
    }
  }

  let inlineTestCount = 0;
  for (const internal of internalMap.values()) {
    for (const tf of internal.testFiles) {
      if (!testFiles.includes(tf)) {
        inlineTestCount++;
      }
    }
  }

  return {
    testFileCount: testFiles.length + inlineTestCount,
    byFileAndSymbol,
    bySymbol,
  };
}

export function lookupFunctionAstEvidence(
  astResult: RepoTestAstResult,
  sourceFileRel: string,
  symbol: string,
): FunctionAstEvidence | undefined {
  const stem = stripCodeExtension(toPosix(sourceFileRel));
  return (
    astResult.byFileAndSymbol.get(`${stem}::${symbol}`) ??
    astResult.byFileAndSymbol.get(`*::${symbol}`) ??
    astResult.bySymbol.get(symbol)
  );
}

