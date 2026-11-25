import { goLanguageAdapter } from "./go.js";
import { javaLanguageAdapter } from "./java.js";
import { rustLanguageAdapter } from "./rust.js";
import { tsLanguageAdapter } from "./ts.js";
import type { LanguageAdapter } from "./shared.js";

export { goLanguageAdapter, javaLanguageAdapter, rustLanguageAdapter, tsLanguageAdapter };
export type {
  FileDependencyContext,
  FileDependencyEdge,
  FunctionLineSpan,
  FunctionStructureMetrics,
  LanguageAdapter,
} from "./shared.js";

export const LANGUAGE_ADAPTERS: readonly LanguageAdapter[] = [
  tsLanguageAdapter,
  goLanguageAdapter,
  rustLanguageAdapter,
  javaLanguageAdapter,
];

export function getLanguageAdapter(filePath: string): LanguageAdapter | undefined {
  const normalized = filePath.replace(/\\/g, "/");
  return LANGUAGE_ADAPTERS.find(
    (adapter) => adapter.isSourceFile(normalized) || adapter.isTestFile(normalized),
  );
}
