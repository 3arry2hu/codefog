export type EvidenceState =
  | "fog-returned"
  | "fog"
  | "self-proof-fog"
  | "weak-evidence"
  | "verified";

/** Five-state count map (used for both executable lines and Doc Claims). */
export type CountByState = Record<EvidenceState, number>;

/** Five-state executable line count map. */
export type LocByState = CountByState;

export interface SurvivingMutant {
  id: string;
  line: number;
  original: string;
  mutated: string;
  testsRun: number;
  killed: boolean;
}

export interface ExternalIssue {
  source: string;
  tool: string;
  ruleId: string;
  message: string;
  file: string;
  line: number;
  startLine: number;
  endLine: number;
  symbol?: string;
  level?: string;
}

export interface LibyearDependencyDrift {
  name: string;
  current?: string;
  latest?: string;
  libyears: number;
  releases?: number;
  major?: number;
  minor?: number;
  patch?: number;
}

export interface LibyearSummary {
  source: "libyear";
  totalLibyears: number;
  dependencies: LibyearDependencyDrift[];
}

export interface ExternalOverlaySummary {
  issues: ExternalIssue[];
  libyear?: LibyearSummary;
}

export interface Finding {
  id: string;
  title: string;
  state: EvidenceState;
  subjectType?: "code" | "doc" | "architecture";
  baselined?: boolean;
  tags?: string[];
  riskScore: number;
  agentReady: boolean;
  location: {
    file: string;
    symbol: string;
    startLine: number;
    endLine: number;
  };
  locations?: Array<{
    file: string;
    symbol: string;
    startLine: number;
    endLine: number;
    command?: string;
  }>;
  reason: string;
  evidence: {
    executedByTests: number;
    assertionsOnOutcome: number;
    pseudoTested: boolean;
    oracleContest: boolean;
    oracleIds: string[];
    missedBoundary: boolean;
    lastCodeChangeAt?: string;
    lastTestChangeAt?: string;
    survivingMutants: SurvivingMutant[];
    /** 1-indexed executable lines in this span with zero test hits. */
    uncoveredLines?: number[];
    /** 1-indexed lines in this span that contain at least one untaken branch. */
    unhitBranchLines?: number[];
    cognitiveComplexity?: number;
    maxNestingDepth?: number;
    errorMaskingLines?: number[];
    externalIssues?: ExternalIssue[];
  };
  /** @deprecated Read `finding.evidence.externalIssues` instead. Kept in sync for compatibility. */
  externalIssues?: ExternalIssue[];
  suggestedAction: string;
  acceptanceCheck: {
    command: string;
    criteria: string[];
  };
}

export interface ModuleSummary {
  path: string;
  totalFiles: number;
  verifiedFilesCollapsed: number;
  trustScore: number;
  maxRiskScore: number;
  locByState: LocByState;
}

export interface FileSymbolRegion {
  symbol: string;
  startLine: number;
  endLine: number;
  loc: number;
  state: EvidenceState;
  riskScore: number;
  cyclomaticComplexity: number;
  cognitiveComplexity?: number;
  maxNestingDepth?: number;
  errorMaskingLines?: number[];
  executedByTests: number;
  assertionsOnOutcome: number;
  pseudoTested: boolean;
  branchCoveragePct: number;
  /** 1-indexed executable lines in this span with zero test hits. */
  uncoveredLines?: number[];
  /** 1-indexed lines in this span that contain at least one untaken branch. */
  unhitBranchLines?: number[];
  lastCodeChangeAt?: string;
  lastTestChangeAt?: string;
  survivingMutants: SurvivingMutant[];
  externalIssues?: ExternalIssue[];
  findingId?: string;
}

export interface FileSummary {
  path: string;
  modulePath: string;
  totalLoc: number;
  unverifiedLoc: number;
  dominantState: EvidenceState;
  trustScore: number;
  riskScore: number;
  churn90d: number;
  shortTermChurn14d?: number;
  cyclomaticComplexity: number;
  locByState: LocByState;
  lines: string[];
  lineStates: Record<number, EvidenceState>;
  regions: FileSymbolRegion[];
  externalIssues?: ExternalIssue[];
  diffStatus?: "fog-returned" | "weakened" | "improved" | "unchanged";
}

export interface DeletedDocClaimEvent {
  file: string;
  claimText: string;
  rawText: string;
  kind: DocClaimKind;
  line: number;
  referent: DocReferent;
}

export interface StructuralRotDelta {
  complexitySpikes: Array<{
    file: string;
    symbol: string;
    line: number;
    before: number;
    after: number;
    delta: number;
  }>;
  addedErrorMasking: Array<{
    file: string;
    line: number;
    pattern: "empty-catch" | "discarded-error" | "empty-error-check" | "unwrap" | "expect";
  }>;
  addedDuplicatedBlocks: Array<{
    file: string;
    startLine: number;
    endLine: number;
    duplicateFile: string;
    duplicateStartLine: number;
    duplicateEndLine: number;
  }>;
}

export interface DiffComparison {
  baseRef: string;
  coverageUpEvidenceDown: boolean;
  alertHeadline: string;
  fogReturnedFiles: string[];
  weakenedFiles: string[];
  changedFiles?: string[];
  newBoundaryViolations?: BoundaryViolation[];
  beforeSummary: {
    trustScore: number;
    docTrustScore?: number;
    totalDocClaims?: number;
    docClaimsByState?: CountByState;
    /** @deprecated Prefer `beforeSummary.metrics.coverageAvailable`; both hold the same boolean. */
    coverageAvailable?: boolean;
    metrics: {
      lineCoveragePct: number;
      branchCoveragePct: number;
      checkedCoveragePct: number;
      mutationScorePct: number;
      pseudoTestedMethods: number;
      contestedOracles: number;
      coverageAvailable?: boolean;
    };
    files: Array<{
      path: string;
      modulePath: string;
      totalLoc: number;
      dominantState: EvidenceState;
      riskScore: number;
      trustScore?: number;
      locByState?: LocByState;
    }>;
  };
  newDocFogReturnedClaims?: DocClaim[];
  deletedDocClaims?: DeletedDocClaimEvent[];
  structuralRot?: StructuralRotDelta;
}

export type DocBlockKind =
  | "paragraph"
  | "table-row"
  | "list-item"
  | "code-block"
  | "heading";

export type DocClaimKind =
  | "symbol"
  | "path"
  | "command"
  | "link"
  | "anchor"
  | "code-block";

export interface DocReferent {
  kind:
    | "symbol"
    | "file"
    | "script"
    | "bin"
    | "anchor"
    | "external-url"
    | "generated-artifact";
  file?: string;
  symbol?: string;
  startLine?: number;
  endLine?: number;
  anchor?: string;
  script?: string;
  scriptDefinition?: string;
  bin?: string;
  subcommand?: string;
  url?: string;
  runtimeFingerprint?: string;
  lastModifiedCommit?: string;
  lastModifiedAt?: string;
}

export interface DocClaim {
  id: string;
  file: string;
  kind: DocClaimKind;
  text: string;
  rawText: string;
  referentText: string;
  startLine: number;
  endLine: number;
  blockKind: DocBlockKind;
  blockStartLine: number;
  blockEndLine: number;
  state: EvidenceState;
  /** Canonical list of all resolved candidate referents (may contain multiple entries for overloaded/duplicate names). */
  referents: DocReferent[];
  /** @deprecated Read `referents` instead; when multiple candidates exist this holds only the first/stale candidate. */
  referent?: DocReferent;
  /** True when an unqualified symbol claim resolved to definitions in two or more distinct source files. */
  ambiguousReferents?: boolean;
  existedAtClaimCommit?: boolean;
  commandIntent?: "install" | "build" | "test" | "lint";
  executionOutput?: string;
}

export interface DocFileSummary {
  path: string;
  modulePath: "docs";
  totalClaims: number;
  unverifiedClaims: number;
  dominantState: EvidenceState;
  trustScore: number;
  riskScore: number;
  claimsByState: CountByState;
  lines: string[];
  lineStates: Record<number, EvidenceState>;
  claims: DocClaim[];
}

export interface ArchitectureEdge {
  from: string;
  to: string;
}

export interface ArchitectureImport extends ArchitectureEdge {
  line: number;
}

export interface ArchitectureCycle {
  modules: string[];
  edges: ArchitectureEdge[];
  file: string;
}

export interface UnstableHub {
  file: string;
  fanIn: number;
  dependents: string[];
  churn90d: number;
  trustScore: number;
  hasFogReturned: boolean;
}

export interface ImplicitCoupling extends ArchitectureEdge {
  coChange: number;
  coupling: number;
}

export interface BoundaryViolationKey extends ArchitectureEdge {
  kind: "rule" | "cycle" | "public-entry";
}

export interface BoundaryViolation extends BoundaryViolationKey {
  file: string;
  reason: string;
  explanation?: string;
  baselined: boolean;
  baselineKey: BoundaryViolationKey;
  edges: ArchitectureImport[];
}

export interface ArchitectureSummary {
  modules: string[];
  edges: ArchitectureEdge[];
  propagationCostPct: number;
  cycles: ArchitectureCycle[];
  unstableHubs: UnstableHub[];
  implicitCouplings: ImplicitCoupling[];
  boundaryViolations: BoundaryViolation[];
  /** Source for architecture links that have no executable coverage region. */
  sourceFiles?: Record<string, string[]>;
}

export interface CodefogReport {
  $schema: "https://codefog.dev/schemas/v1/report.json";
  version: "1.0.0";
  repository: {
    name: string;
    branch: string;
    commit: string;
    generatedAt: string;
    baseRef?: string;
  };
  summary: {
    trustScore: number;
    docTrustScore?: number;
    totalDocClaims?: number;
    docClaimsByState?: CountByState;
    totalFiles: number;
    totalLoc: number;
    metrics: {
      lineCoveragePct: number;
      branchCoveragePct: number;
      checkedCoveragePct: number;
      mutationScorePct: number;
      pseudoTestedMethods: number;
      contestedOracles: number;
      coverageAvailable?: boolean;
      mutationAvailable?: boolean;
    };
    locByState: LocByState;
  };
  /** @deprecated Read `summary.docTrustScore` instead. Kept in sync for compatibility. */
  docTrustScore?: number;
  docClaims?: DocClaim[];
  docFiles?: DocFileSummary[];
  modules: ModuleSummary[];
  findings: Finding[];
  files: FileSummary[];
  warnings?: string[];
  diff?: DiffComparison;
  external?: ExternalOverlaySummary;
  libyear?: LibyearSummary;
  architecture?: ArchitectureSummary;
}

export interface AnalyzeOptions {
  rootDir: string;
  arch?: boolean;
  archConfigPath?: string;
  /** @deprecated Prefer `coveragePath`, which accepts LCOV, Go coverprofile, or JaCoCo XML. */
  lcovPath?: string;
  coveragePath?: string | string[];
  /** @deprecated Prefer `mutationReportPath`, which accepts Stryker, PITest, or cargo-mutants reports. */
  strykerPath?: string;
  mutationReportPath?: string;
  expectationsPath?: string;
  defectsPath?: string;
  diffBase?: string;
  docs?: boolean;
  checkExternalLinks?: boolean;
  runDocs?: boolean;
  sarifPath?: string | string[];
  knipPath?: string | string[];
  libyearPath?: string | string[];
}
