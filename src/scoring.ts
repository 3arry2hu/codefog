import * as crypto from "node:crypto";
import type { EvidenceState, LocByState } from "./types.js";

/**
 * Five-State Fog-First OKLCH Slate Scale + Fog Returned Warning Orange (#BD4900)
 * Defined in ADR 0001.
 */
export const STATE_COLORS: Record<EvidenceState, string> = {
  verified: "#EBEFF4",
  "weak-evidence": "#BCCCE2",
  "self-proof-fog": "#6E88AA",
  fog: "#1D3656",
  "fog-returned": "#BD4900",
};

/**
 * Evidence quality rank (higher = stronger verification evidence).
 */
export const STATE_EVIDENCE_RANK: Record<EvidenceState, number> = {
  verified: 5,
  "weak-evidence": 4,
  "self-proof-fog": 3,
  fog: 2,
  "fog-returned": 1,
};

export const STATE_URGENCY_ORDER: EvidenceState[] = [
  "fog-returned",
  "fog",
  "self-proof-fog",
  "weak-evidence",
  "verified",
];

export function emptyLocByState(): LocByState {
  return {
    "fog-returned": 0,
    fog: 0,
    "self-proof-fog": 0,
    "weak-evidence": 0,
    verified: 0,
  };
}

export function computeTrustScore(locByState: LocByState): number {
  const total =
    locByState["fog-returned"] +
    locByState.fog +
    locByState["self-proof-fog"] +
    locByState["weak-evidence"] +
    locByState.verified;

  if (total <= 0) return 100;

  const weighted =
    1.0 * locByState.verified +
    0.4 * locByState["weak-evidence"] +
    0.3 * locByState["self-proof-fog"] -
    0.5 * locByState["fog-returned"];

  const raw = Math.round((weighted / total) * 100);
  return Math.max(0, Math.min(100, raw));
}

const STATE_WEIGHTS: Record<EvidenceState, number> = {
  "fog-returned": 2.0,
  fog: 1.4,
  "self-proof-fog": 1.2,
  "weak-evidence": 1.0,
  verified: 0.0,
};

export function computeRiskScore(params: {
  unverifiedLoc: number;
  churn90d: number;
  cyclomaticComplexity: number;
  state: EvidenceState;
}): number {
  const weight = STATE_WEIGHTS[params.state];
  if (weight === 0 || params.unverifiedLoc <= 0) return 0.0;

  const locFactor = Math.log(1 + Math.max(1, params.unverifiedLoc));
  const churnFactor = Math.log(1 + Math.max(1, params.churn90d));
  const complexityFactor = Math.log(1 + Math.max(1, params.cyclomaticComplexity));

  const raw = locFactor * churnFactor * complexityFactor * weight;
  // Normalize smoothly into [0.0, 10.0]
  const normalized = Math.min(10.0, Math.max(0.1, (raw / (raw + 3.5)) * 10));
  return Math.round(normalized * 10) / 10;
}

export function createDeterministicFindingId(file: string, symbol: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(`${file}::${symbol}`)
    .digest("hex")
    .slice(0, 4)
    .toUpperCase();
  return `CF-${hash}`;
}

export function roundPct(numerator: number, denominator: number): number {
  if (denominator <= 0) return 100;
  return Math.round((numerator / denominator) * 1000) / 10;
}

export function getDominantState(locByState: LocByState): EvidenceState {
  for (const state of STATE_URGENCY_ORDER) {
    if (locByState[state] > 0) {
      return state;
    }
  }
  return "verified";
}
