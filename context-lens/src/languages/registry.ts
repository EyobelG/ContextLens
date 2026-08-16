import { javascriptAdapter, typescriptAdapter } from "./javascript.js";
import { pythonAdapter } from "./python.js";
import { LanguageAdapter } from "./types.js";

export const ALL_ADAPTERS: LanguageAdapter[] = [pythonAdapter, javascriptAdapter, typescriptAdapter];

const BY_VSCODE_LANGUAGE_ID = new Map<string, LanguageAdapter>();
for (const adapter of ALL_ADAPTERS) {
  for (const languageId of adapter.vscodeLanguageIds) BY_VSCODE_LANGUAGE_ID.set(languageId, adapter);
}

export function getAdapterForLanguageId(languageId: string): LanguageAdapter | undefined {
  return BY_VSCODE_LANGUAGE_ID.get(languageId);
}

export const SUPPORTED_VSCODE_LANGUAGE_IDS = [...BY_VSCODE_LANGUAGE_ID.keys()];
