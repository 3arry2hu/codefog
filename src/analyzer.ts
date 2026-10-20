import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ts from "typescript";
import { loadCoverageRecords, type LcovFileRecord } from "./lcov.js";
import { analyzeTestAstEvidence, lookupFunctionAstEvidence } from "./ast-evidence.js";
import { analyzeFileGitFreshness } from "./git-freshness.js";
import { getSpanMutationSummary, loadStrykerReport, type ParsedStrykerReport } from "./mutation.js";
import { assessSymbolOracle, lastCommitHash, loadOracleBundle } from "./oracle.js";
import {
  extractPolyglotFunctionSpans,
  getPolyglotAdapter,
  isPolyglotSourceFile,
} from "./polyglot.js";
import {
  computeRiskScore,
  computeTrustScore,
  createDeterministicFindingId,
  emptyLocByState,
  getDominantState,
  roundPct,
} from "./scoring.js";
import type {
  AnalyzeOptions,
  CodefogReport,
  EvidenceState,
  FileSummary,
  FileSymbolRegion,
  Finding,
  ModuleSummary,
} from "./types.js";

const execFileAsync = promisify(execFile);

interface ParsedFunctionSpan {
  name: string;
  startLine: number;
  endLine: number;
  cyclomaticComplexity: number;
}

function extractFunctionSpans(sourceText: string, fileName: string): ParsedFunctionSpan[] {
  if (isPolyglotSourceFile(fileName)) {
    return extractPolyglotFunctionSpans(sourceText, fileName);
  }
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const spans: ParsedFunctionSpan[] = [];

  function countComplexity(node: ts.Node): number {
    let complexity = 1;
    function walk(n: ts.Node): void {
      switch (n.kind) {
        case ts.SyntaxKind.IfStatement:
        case ts.SyntaxKind.ForStatement:
        case ts.SyntaxKind.ForInStatement:
        case ts.SyntaxKind.ForOfStatement:
        case ts.SyntaxKind.WhileStatement:
        case ts.SyntaxKind.DoStatement:
        case ts.SyntaxKind.CaseClause:
        case ts.SyntaxKind.CatchClause:
        case ts.SyntaxKind.ConditionalExpression:
          complexity++;
          break;
        case ts.SyntaxKind.BinaryExpression: {
          const bin = n as ts.BinaryExpression;
          if (
            bin.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
            bin.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
            bin.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
          ) {
            complexity++;
          }
          break;
        }
      }
      ts.forEachChild(n, walk);
    }
    walk(node);
    return complexity;
  }

  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name) {
      const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
      spans.push({
        name: node.name.text,
        startLine: start,
        endLine: end,
        cyclomaticComplexity: countComplexity(node),
      });
      return;
    }
    if (ts.isMethodDeclaration(node) && node.name) {
      const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
      spans.push({
        name: node.name.getText(sourceFile),
        startLine: start,
        endLine: end,
        cyclomaticComplexity: countComplexity(node),
      });
      return;
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
      spans.push({
        name: node.name.text,
        startLine: start,
        endLine: end,
        cyclomaticComplexity: countComplexity(node.initializer),
      });
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return spans.sort((a, b) => a.startLine - b.startLine);
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

async function readGitMeta(rootDir: string): Promise<{ branch: string; commit: string }> {
  try {
    const [branchRes, commitRes] = await Promise.all([
      execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: rootDir }),
      execFileAsync("git", ["rev-parse", "--short", "HEAD"], { cwd: rootDir }),
    ]);
    return {
      branch: branchRes.stdout.trim() || "main",
      commit: commitRes.stdout.trim() || "0000000",
    };
  } catch {
    return { branch: "main", commit: "0000000" };
  }
}

export async function analyzeRepository(options: AnalyzeOptions): Promise<CodefogReport> {
  const rootDir = path.resolve(options.rootDir);
  const { records: lcovRecords, mtimeMs: lcovMtimeMs } = await loadCoverageRecords(
    rootDir,
    options.coveragePath ?? options.lcovPath,
  );
  const astResult = await analyzeTestAstEvidence(rootDir);
  const mutationPath = options.mutationReportPath ?? options.strykerPath;
  const strykerReport: ParsedStrykerReport | undefined = mutationPath
    ? await loadStrykerReport(rootDir, mutationPath)
    : undefined;
  const gitMeta = await readGitMeta(rootDir);
  const oracleBundle = await loadOracleBundle(rootDir, {
    expectationsPath: options.expectationsPath,
    defectsPath: options.defectsPath,
  });

  let totalLinesFound = 0;
  let totalLinesHit = 0;
  let totalBranchesFound = 0;
  let totalBranchesHit = 0;
  let totalCheckedLines = 0;
  let totalPseudoTestedMethods = 0;
  let totalContestedOracles = 0;

  const files: FileSummary[] = [];
  const findings: Finding[] = [];

  for (const [relPath, record] of lcovRecords.entries()) {
    const absPath = path.join(rootDir, relPath);
    let sourceText = "";
    try {
      sourceText = await fs.readFile(absPath, "utf8");
    } catch {
      sourceText = "";
    }
    const sourceLines = sourceText ? sourceText.split(/\r?\n/) : [];
    const spans = sourceText
      ? extractFunctionSpans(sourceText, relPath)
      : record.functions.map((f, idx, arr) => ({
          name: f.name,
          startLine: f.line,
          endLine: arr[idx + 1] ? arr[idx + 1]!.line - 1 : Math.max(f.line, ...record.lines.keys()),
          cyclomaticComplexity: 1,
        }));

    const adapter = getPolyglotAdapter(relPath);
    if (adapter?.filterProductionLines && spans.length > 0) {
      adapter.filterProductionLines(record.lines, spans as any);
      record.linesFound = record.lines.size;
      record.linesHit = Array.from(record.lines.values()).filter((v) => v > 0).length;
    }

    totalLinesFound += record.linesFound;
    totalLinesHit += record.linesHit;
    totalBranchesFound += record.branchesFound;
    totalBranchesHit += record.branchesHit;

    const effectiveSpans: ParsedFunctionSpan[] =
      spans.length > 0
        ? spans
        : [
            {
              name: path.basename(relPath, path.extname(relPath)),
              startLine: 1,
              endLine: Math.max(1, sourceLines.length, ...record.lines.keys()),
              cyclomaticComplexity: 1,
            },
          ];

    const fileLocByState = emptyLocByState();
    const lineStates: Record<number, EvidenceState> = {};
    const regions: FileSymbolRegion[] = [];

    const associatedTestFiles = new Map<string, string[]>();
    for (const span of effectiveSpans) {
      const ev = lookupFunctionAstEvidence(astResult, relPath, span.name);
      if (ev && ev.testFiles.length > 0) {
        associatedTestFiles.set(span.name, ev.testFiles);
      }
    }

    const gitFreshness = await analyzeFileGitFreshness({
      rootDir,
      relPath,
      currentSourceText: sourceText,
      functionSpans: effectiveSpans.map((s) => ({
        name: s.name,
        startLine: s.startLine,
        endLine: s.endLine,
      })),
      associatedTestFiles,
      reportGeneratedAtMs: lcovMtimeMs,
    });
    const fileChurn90d = gitFreshness.churn90d;
    const sourceCommit = await lastCommitHash(rootDir, relPath);

    for (const span of effectiveSpans) {
      const fnRecord = record.functions.find((f) => f.name === span.name);
      const lineDelta = fnRecord ? span.startLine - fnRecord.line : 0;
      const lcovStartLine = span.startLine - lineDelta;
      const lcovEndLine = span.endLine - lineDelta;

      const spanLines: Array<[number, number]> = [];
      for (const [ln, hits] of record.lines.entries()) {
        if (ln >= lcovStartLine && ln <= lcovEndLine) {
          spanLines.push([ln + lineDelta, hits]);
        }
      }

      if (spanLines.length === 0) continue;

      const spanBranches = record.branches.filter(
        (b) => b.line >= lcovStartLine && b.line <= lcovEndLine,
      );
      const spanBranchHit = spanBranches.filter((b) => b.taken > 0).length;
      const spanBranchPct = roundPct(spanBranchHit, spanBranches.length);
      const hasIncompleteBranches =
        spanBranches.length > 0 && spanBranchHit < spanBranches.length;

      const hitsCount = spanLines.filter(([, h]) => h > 0).length;
      const lcovFnHits = fnRecord ? fnRecord.hits : hitsCount > 0 ? 1 : 0;

      const astEvidence = lookupFunctionAstEvidence(astResult, relPath, span.name);
      const executedByTests =
        hitsCount === 0
          ? 0
          : astEvidence
            ? Math.max(1, astEvidence.executedTestBlocks)
            : Math.max(1, lcovFnHits);

      const assertionsOnOutcome =
        hitsCount === 0
          ? 0
          : astResult.testFileCount > 0
            ? astEvidence?.assertionsOnOutcome ?? 0
            : 1;

      const pseudoTested = hitsCount > 0 && assertionsOnOutcome === 0;
      if (pseudoTested) {
        totalPseudoTestedMethods++;
      }

      const fnFreshness = gitFreshness.functions.get(span.name);
      const fileMutationSummary = strykerReport?.byFile.get(relPath);
      const spanMutants = getSpanMutationSummary(
        fileMutationSummary,
        span.startLine,
        span.endLine,
      );
      const hasSurvivingMutants = spanMutants.survivingMutants.length > 0;
      const oracle = await assessSymbolOracle({
        rootDir,
        file: relPath,
        symbol: span.name,
        testFiles: astEvidence?.testFiles ?? [],
        bundle: oracleBundle,
        sourceCommit,
      });
      if (oracle.contested) totalContestedOracles++;

      let regionState: EvidenceState;
      if (hitsCount === 0) {
        regionState = "fog";
      } else if (fnFreshness?.isFogReturned) {
        regionState = "fog-returned";
      } else if (pseudoTested || hasIncompleteBranches || hasSurvivingMutants) {
        regionState = "weak-evidence";
      } else if (oracle.contested) {
        regionState = "self-proof-fog";
      } else if (fnFreshness?.isSelfProofFog && !oracle.independentlyConfirmed) {
        regionState = "self-proof-fog";
      } else if (oracle.missedBoundary) {
        regionState = "weak-evidence";
      } else {
        regionState = "verified";
      }

      for (const [ln, hits] of spanLines) {
        if (lineStates[ln] !== undefined) continue;
        const lineState: EvidenceState = hits > 0 ? regionState : "fog";
        lineStates[ln] = lineState;
        fileLocByState[lineState]++;
        if (hits > 0 && assertionsOnOutcome > 0 && regionState !== "fog-returned") {
          totalCheckedLines++;
        }
      }

      const unverifiedInSpan =
        regionState === "verified" ? 0 : spanLines.length;
      const regionRisk = computeRiskScore({
        unverifiedLoc: regionState === "verified" ? 0 : Math.max(1, unverifiedInSpan),
        churn90d: fileChurn90d,
        cyclomaticComplexity: span.cyclomaticComplexity,
        state: regionState,
      });

      const findingId =
        regionState !== "verified"
          ? createDeterministicFindingId(relPath, span.name)
          : undefined;

      regions.push({
        symbol: span.name,
        startLine: span.startLine,
        endLine: span.endLine,
        loc: spanLines.length,
        state: regionState,
        riskScore: regionRisk,
        cyclomaticComplexity: span.cyclomaticComplexity,
        executedByTests,
        assertionsOnOutcome,
        pseudoTested,
        branchCoveragePct: spanBranchPct,
        lastCodeChangeAt: fnFreshness?.lastCodeChangeAt,
        lastTestChangeAt: fnFreshness?.lastTestChangeAt,
        survivingMutants: spanMutants.survivingMutants,
        findingId,
      });

      if (regionState !== "verified" && findingId) {
        let reason: string;
        let suggestedAction: string;
        if (regionState === "fog-returned") {
          reason = `Executable logic in ${span.name} changed after its associated test evidence (Fog Returned).`;
          suggestedAction = `Update or add tests for the modified runtime logic in ${span.name} (${relPath}:${span.startLine}-${span.endLine}) and re-verify.`;
          if (oracle.contested) {
            reason += ` Outcome assertion also contradicts ${oracle.contestIds.join(", ")} (Oracle Contest).`;
            suggestedAction = `Do not rewrite the outcome assertion for ${span.name} to the current return value. Reconcile it with ${oracle.contestIds.join(", ")} before updating tests.`;
          }
        } else if (regionState === "fog") {
          reason = `No test evidence executing ${span.name} (${spanLines.length} lines in fog).`;
          suggestedAction = `Add unit tests covering ${span.name} in ${relPath} (lines ${span.startLine}-${span.endLine}) with outcome assertions.`;
        } else if (oracle.contested) {
          reason = `Outcome assertion for ${span.name} contradicts ${oracle.contestIds.join(", ")} (Oracle Contest). Killing mutants cannot confirm a coupled assertion.`;
          suggestedAction = `Do not rewrite the outcome assertion for ${span.name} to the current return value. Reconcile the implementation or the assertion with ${oracle.contestIds.join(", ")}.`;
        } else if (regionState === "self-proof-fog") {
          reason = `${span.name} and its outcome assertion were authored in the same commit (Coupled Assertion). Mutation score cannot promote this Self-proof Fog to Verified.`;
          suggestedAction = `Confirm an Independent Expectation for ${span.name} in a separate commit. Do not rewrite the outcome assertion to match the current return value.`;
        } else if (pseudoTested) {
          reason = `${span.name} is executed by ${executedByTests} test(s) but has 0 outcome assertions (pseudo-tested method).`;
          suggestedAction = `Add explicit outcome assertions on the return value or side effects of ${span.name} in ${relPath} (lines ${span.startLine}-${span.endLine}).`;
        } else if (hasSurvivingMutants) {
          const firstMut = spanMutants.survivingMutants[0]!;
          reason = `${spanMutants.survivingMutants.length} mutant(s) survived in ${span.name} (e.g. line ${firstMut.line}: '${firstMut.original}' -> '${firstMut.mutated}').`;
          suggestedAction = `Add boundary and behavioral assertions in tests for ${span.name} (${relPath}:${span.startLine}-${span.endLine}) to kill surviving mutant(s).`;
        } else if (oracle.missedBoundary) {
          const expected = oracle.confirmedExpectedLiteral ?? "the confirmed outcome";
          reason = `Historical defect ${oracle.missedIds.join(", ")} input is not asserted for ${span.name} (missed boundary).`;
          suggestedAction = `Add an outcome assertion for ${span.name} covering ${oracle.missedIds.join(", ")} and expecting ${expected}. Do not copy the current return value.`;
        } else {
          reason = `${span.name} has incomplete branch coverage (${spanBranchPct}% branches taken).`;
          suggestedAction = `Add branch tests for ${span.name} in ${relPath} (lines ${span.startLine}-${span.endLine}) to cover all conditional paths with outcome assertions.`;
        }

        findings.push({
          id: findingId,
          title: span.name,
          state: regionState,
          riskScore: regionRisk,
          agentReady: !oracle.contested && regionState !== "self-proof-fog",
          location: {
            file: relPath,
            symbol: span.name,
            startLine: span.startLine,
            endLine: span.endLine,
          },
          reason,
          evidence: {
            executedByTests,
            assertionsOnOutcome,
            pseudoTested,
            oracleContest: oracle.contested,
            oracleIds: oracle.contested ? oracle.contestIds : oracle.missedIds,
            missedBoundary: oracle.missedBoundary,
            ...(fnFreshness?.lastCodeChangeAt ? { lastCodeChangeAt: fnFreshness.lastCodeChangeAt } : {}),
            ...(fnFreshness?.lastTestChangeAt ? { lastTestChangeAt: fnFreshness.lastTestChangeAt } : {}),
            survivingMutants: spanMutants.survivingMutants,
          },
          suggestedAction,
          acceptanceCheck: {
            command: `npx codefog verify ${relPath} --mutants --oracle --lines ${span.startLine}-${span.endLine}`,
            criteria: [
              `Lines ${span.startLine}-${span.endLine} in ${relPath} reach verified state`,
              `All mutants in ${span.name} are killed`,
              ...(oracle.contested || regionState === "self-proof-fog"
                ? [
                    `The outcome assertion literal for ${span.name} is not rewritten to the current return value`,
                  ]
                : []),
            ],
          },
        });
      }
    }

    // Account for any instrumented lines outside function spans
    const coveredBySpans = new Set(Object.keys(lineStates).map(Number));
    if (coveredBySpans.size === 0) {
      for (const [ln, hits] of record.lines.entries()) {
        const st: EvidenceState = hits > 0 ? "verified" : "fog";
        lineStates[ln] = st;
        fileLocByState[st]++;
        if (st === "verified") {
          totalCheckedLines++;
        }
      }
    }

    const totalFileLoc =
      fileLocByState["fog-returned"] +
      fileLocByState.fog +
      fileLocByState["self-proof-fog"] +
      fileLocByState["weak-evidence"] +
      fileLocByState.verified;
    const unverifiedLoc = totalFileLoc - fileLocByState.verified;
    const dominantState = getDominantState(fileLocByState);
    const totalComplexity = regions.reduce((acc, r) => acc + r.cyclomaticComplexity, 0) || 1;
    const fileRisk = computeRiskScore({
      unverifiedLoc,
      churn90d: fileChurn90d,
      cyclomaticComplexity: totalComplexity,
      state: dominantState,
    });

    files.push({
      path: relPath,
      modulePath: deriveModulePath(relPath),
      totalLoc: totalFileLoc,
      unverifiedLoc,
      dominantState,
      trustScore: computeTrustScore(fileLocByState),
      riskScore: fileRisk,
      churn90d: fileChurn90d,
      cyclomaticComplexity: totalComplexity,
      locByState: fileLocByState,
      lines: sourceLines,
      lineStates,
      regions,
    });
  }

  // Group into modules
  const moduleMap = new Map<string, FileSummary[]>();
  for (const file of files) {
    const list = moduleMap.get(file.modulePath) ?? [];
    list.push(file);
    moduleMap.set(file.modulePath, list);
  }

  const modules: ModuleSummary[] = [];
  for (const [modPath, modFiles] of moduleMap.entries()) {
    const modLoc = emptyLocByState();
    let verifiedFilesCollapsed = 0;
    let maxRiskScore = 0;

    for (const f of modFiles) {
      for (const k of Object.keys(modLoc) as EvidenceState[]) {
        modLoc[k] += f.locByState[k];
      }
      if (f.dominantState === "verified") {
        verifiedFilesCollapsed++;
      }
      if (f.riskScore > maxRiskScore) {
        maxRiskScore = f.riskScore;
      }
    }

    modules.push({
      path: modPath,
      totalFiles: modFiles.length,
      verifiedFilesCollapsed,
      trustScore: computeTrustScore(modLoc),
      maxRiskScore,
      locByState: modLoc,
    });
  }

  modules.sort((a, b) => b.maxRiskScore - a.maxRiskScore || a.trustScore - b.trustScore);
  findings.sort((a, b) => b.riskScore - a.riskScore || a.id.localeCompare(b.id));
  files.sort((a, b) => b.riskScore - a.riskScore || a.path.localeCompare(b.path));

  const repoLocByState = emptyLocByState();
  for (const m of modules) {
    for (const k of Object.keys(repoLocByState) as EvidenceState[]) {
      repoLocByState[k] += m.locByState[k];
    }
  }

  const totalLoc =
    repoLocByState["fog-returned"] +
    repoLocByState.fog +
    repoLocByState["self-proof-fog"] +
    repoLocByState["weak-evidence"] +
    repoLocByState.verified;

  const report: CodefogReport = {
    $schema: "https://codefog.dev/schemas/v1/report.json",
    version: "1.0.0",
    repository: {
      name: path.basename(rootDir),
      branch: gitMeta.branch,
      commit: gitMeta.commit,
      generatedAt: new Date().toISOString(),
      ...(options.diffBase ? { baseRef: options.diffBase } : {}),
    },
    summary: {
      trustScore: computeTrustScore(repoLocByState),
      totalFiles: files.length,
      totalLoc,
      metrics: {
        lineCoveragePct: roundPct(totalLinesHit, totalLinesFound),
        branchCoveragePct: roundPct(totalBranchesHit, totalBranchesFound),
        checkedCoveragePct: roundPct(totalCheckedLines, totalLinesFound),
        mutationScorePct: strykerReport?.mutationScorePct ?? 0,
        pseudoTestedMethods: totalPseudoTestedMethods,
        contestedOracles: totalContestedOracles,
      },
      locByState: repoLocByState,
    },
    modules,
    findings,
    files,
  };

  return report;
}
