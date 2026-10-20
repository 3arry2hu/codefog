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

export interface Finding {
  id: string;
  title: string;
  state: EvidenceState;
  riskScore: number;
  agentReady: boolean;
  location: {
    file: string;
    symbol: string;
    startLine: number;
    endLine: number;
  };
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
  };
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
  diffStatus?: "fog-returned" | "weakened" | "improved" | "unchanged";
}

export interface DiffComparison {
  baseRef: string;
  coverageUpEvidenceDown: boolean;
  alertHeadline: string;
  fogReturnedFiles: string[];
  weakenedFiles: string[];
  beforeSummary: {
    trustScore: number;
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
  modules: ModuleSummary[];
  findings: Finding[];
  files: FileSummary[];
  diff?: DiffComparison;
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
}
