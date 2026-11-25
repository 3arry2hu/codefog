export {
  REPO_IGNORED_DIRS,
  findFilesByExtensionInRepo,
  isIgnoredRepoDir,
  isIgnoredRepoRelPath,
  loadGitignoreMatchers,
  walkRepoFiles,
} from "./path-utils.js";

export type {
  LanguageAdapter,
  PolyglotAstEvidenceEntry,
  PolyglotCandidateMutation,
  PolyglotExtractedSymbol,
  PolyglotFunctionSpan,
  PolyglotRepoAstEvidence,
  SupportedLanguageId,
} from "./adapters/shared.js";
export {
  findMatchingDelimiter,
  isCompilerErrorOutput,
  stripCommentsAndMaskStrings,
} from "./adapters/shared.js";

import { goLanguageAdapter } from "./adapters/go.js";
import { rustLanguageAdapter } from "./adapters/rust.js";
import { javaLanguageAdapter } from "./adapters/java.js";
import type { LanguageAdapter, PolyglotFunctionSpan } from "./adapters/shared.js";

export * from "./adapters/go.js";
export * from "./adapters/rust.js";
export * from "./adapters/java.js";

export const POLYGLOT_LANGUAGE_ADAPTERS: readonly LanguageAdapter[] = [
  goLanguageAdapter,
  rustLanguageAdapter,
  javaLanguageAdapter,
];

export function getPolyglotAdapter(filePath: string): LanguageAdapter | undefined {
  return POLYGLOT_LANGUAGE_ADAPTERS.find(
    (a) => a.isSourceFile(filePath) || a.isTestFile(filePath),
  );
}

export function isPolyglotSourceFile(fileName: string): boolean {
  return POLYGLOT_LANGUAGE_ADAPTERS.some((a) => a.isSourceFile(fileName));
}

export function isPolyglotTestFile(fileName: string): boolean {
  return POLYGLOT_LANGUAGE_ADAPTERS.some((a) => a.isTestFile(fileName));
}

export function extractPolyglotFunctionSpans(
  sourceText: string,
  fileName: string,
): PolyglotFunctionSpan[] {
  return getPolyglotAdapter(fileName)?.extractFunctionSpans(sourceText, fileName) ?? [];
}

export function extractPolyglotRuntimeFingerprints(
  sourceText: string,
  fileName: string,
): Map<string, string> {
  return (
    getPolyglotAdapter(fileName)?.extractRuntimeFingerprints(sourceText, fileName) ?? new Map()
  );
}
