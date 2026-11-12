export type EvidenceState =
  | "fog-returned"
  | "fog"
  | "self-proof-fog"
  | "weak-evidence"
  | "verified";

export type LocByState = Record<EvidenceState, number>;

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
  subjectType?: "code" | "doc";
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
    externalIssues?: ExternalIssue[];
  };
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
  executedByTests: number;
  assertionsOnOutcome: number;
  pseudoTested: boolean;
  branchCoveragePct: number;
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

export interface DiffComparison {
  baseRef: string;
  coverageUpEvidenceDown: boolean;
  alertHeadline: string;
  fogReturnedFiles: string[];
  weakenedFiles: string[];
  beforeSummary: {
    trustScore: number;
    docTrustScore?: number;
    totalDocClaims?: number;
    docClaimsByState?: LocByState;
    metrics: {
      lineCoveragePct: number;
      branchCoveragePct: number;
      checkedCoveragePct: number;
      mutationScorePct: number;
      pseudoTestedMethods: number;
      contestedOracles: number;
    };
    files: Array<{
      path: string;
      modulePath: string;
      totalLoc: number;
      dominantState: EvidenceState;
      riskScore: number;
    }>;
  };
  newDocFogReturnedClaims?: DocClaim[];
  deletedDocClaims?: DeletedDocClaimEvent[];
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
  referents: DocReferent[];
  referent?: DocReferent;
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
  claimsByState: LocByState;
  lines: string[];
  lineStates: Record<number, EvidenceState>;
  claims: DocClaim[];
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
    docClaimsByState?: LocByState;
    totalFiles: number;
    totalLoc: number;
    metrics: {
      lineCoveragePct: number;
      branchCoveragePct: number;
      checkedCoveragePct: number;
      mutationScorePct: number;
      pseudoTestedMethods: number;
      contestedOracles: number;
    };
    locByState: LocByState;
  };
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
}

export interface AnalyzeOptions {
  rootDir: string;
  lcovPath?: string;
  coveragePath?: string | string[];
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
