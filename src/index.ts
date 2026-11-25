// Public domain types & report schema
export type {
  AnalyzeOptions,
  ArchitectureCycle,
  ArchitectureEdge,
  ArchitectureImport,
  ArchitectureSummary,
  BoundaryViolation,
  BoundaryViolationKey,
  CodefogReport,
  CountByState,
  DeletedDocClaimEvent,
  DiffComparison,
  DocBlockKind,
  DocClaim,
  DocClaimKind,
  DocFileSummary,
  DocReferent,
  EvidenceState,
  ExternalIssue,
  ExternalOverlaySummary,
  FileSummary,
  FileSymbolRegion,
  Finding,
  ImplicitCoupling,
  LibyearDependencyDrift,
  LibyearSummary,
  LocByState,
  ModuleSummary,
  StructuralRotDelta,
  SurvivingMutant,
  UnstableHub,
} from "./types.js";

// Core repository analysis & verification entry points
export { analyzeRepository, deriveModulePath } from "./analyzer.js";
export {
  isDocVerifyTarget,
  verifyDocTarget,
  verifyTargetWithMutants,
  type VerifyOptions,
  type VerifyResult,
} from "./verify.js";
export { analyzeDocClaims, type DocAnalysisResult } from "./doc-claims.js";

// Coverage, mutation, oracle & external overlay loaders
export {
  loadCoverageRecords,
  normalizeRepoRelativePath,
  parseGoCoverProfile,
  parseJacocoXml,
  parseLcov,
  type CoverageBranchEntry,
  type CoverageFileRecord,
  type CoverageFunctionEntry,
  type LcovBranchEntry,
  type LcovFileRecord,
  type LcovFunctionEntry,
  type LoadedCoverage,
} from "./lcov.js";
export {
  getSpanMutationSummary,
  loadMutationReport,
  loadStrykerReport,
  type MutationFileSummary,
  type MutationRecord,
  type ParsedMutationReport,
  type ParsedStrykerReport,
  type StrykerFileSummary,
  type StrykerMutantRecord,
} from "./mutation.js";
export {
  assessSymbolOracle,
  judgeSymbolOracle,
  loadOracleBundle,
  type DefectRecord,
  type ExpectationRecord,
  type OracleBundle,
  type SymbolOracleVerdict,
} from "./oracle.js";
export {
  loadExternalOverlay,
  matchRegionExternalIssues,
  normalizeExternalRelPath,
  parseKnipContent,
  parseLibyearContent,
  parseSarifContent,
  type LoadExternalOverlayInput,
} from "./external.js";

// Scoring, palette & treemap layout
export {
  STATE_COLORS,
  STATE_EVIDENCE_RANK,
  STATE_URGENCY_ORDER,
  computeRiskScore,
  computeTrustScore,
  createDeterministicFindingId,
  emptyLocByState,
  getDominantState,
  roundPct,
} from "./scoring.js";
export { squarify, type TreemapRect } from "./treemap.js";

// Polyglot LanguageAdapter seam (ADR-0003)
export {
  POLYGLOT_LANGUAGE_ADAPTERS,
  getPolyglotAdapter,
  goLanguageAdapter,
  isPolyglotSourceFile,
  isPolyglotTestFile,
  javaLanguageAdapter,
  rustLanguageAdapter,
  type LanguageAdapter,
  type PolyglotAstEvidenceEntry,
  type PolyglotCandidateMutation,
  type PolyglotExtractedSymbol,
  type PolyglotFunctionSpan,
  type PolyglotRepoAstEvidence,
  type SupportedLanguageId,
} from "./polyglot.js";

export {
  getLanguageAdapter,
  LANGUAGE_ADAPTERS,
  tsLanguageAdapter,
  type FileDependencyContext,
  type FileDependencyEdge,
  type FunctionLineSpan,
  type FunctionStructureMetrics,
} from "./adapters/index.js";

// Renderers, PR diff & CLI
export { renderHtmlFogMap, writeHtmlFogMap } from "./html-report.js";
export {
  computeDiffComparison,
  renderPrCommentDocSection,
  renderPrCommentMarkdown,
  renderPrDiffSvg,
  resolveBaseRef,
  writePrCommentArtifacts,
} from "./diff-pr.js";
export {
  installCodefogSkill,
  normalizeSkillAgents,
  renderCodefogSkillMarkdown,
  SUPPORTED_SKILL_AGENTS,
  type InstalledSkillTarget,
  type InstallSkillOptions,
  type InstallSkillResult,
  type SupportedSkillAgent,
} from "./skill-installer.js";
export {
  MIN_SUPPORTED_NPM_MAJOR,
  detectOutdatedNpmVersion,
  formatLevel1Summary,
  formatOutdatedNpmWarning,
  runCli,
  type CliIo,
} from "./cli.js";
export {
  STATE_BAR_GLYPHS,
  STATE_BAR_WIDTH,
  TERMINAL_MAX_COLUMNS,
  formatLevel1SummaryColor,
  shouldUseColor,
  stateBarCells,
  stripAnsi,
} from "./terminal-summary.js";
