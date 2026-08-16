import * as vscode from "vscode";
import { callModel, resolveApiKey } from "./llmClient.js";
import { DependencyMetadata, LanguageAdapter } from "./languages/types.js";
import { DiagnosticFinding, parseFindings } from "./diagnosticsParser.js";
import { WorkspaceRagIndex } from "./ragEngine.js";

export type { DiagnosticFinding } from "./diagnosticsParser.js";

const SYSTEM_PROMPT = "You are a meticulous senior code reviewer. Respond with strict JSON only — no prose, no markdown code fences.";

export async function explainIssues(
  source: string, dependencies: DependencyMetadata, adapter: LanguageAdapter, index: WorkspaceRagIndex,
  report: (message: string) => void, token?: vscode.CancellationToken
): Promise<DiagnosticFinding[]> {
  const settings = vscode.workspace.getConfiguration("contextLens");
  const { apiKey, providerHint } = resolveApiKey(settings);
  if (!apiKey) throw new Error("ContextLens requires contextLens.apiKey (or the ANTHROPIC_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY environment variable) to explain issues.");
  report("Retrieving relevant codebase context...");
  const context = index.retrieveContext(dependencies, source, { limit: 6, preferTestArtifacts: false });
  report("Analyzing code for issues...");
  const raw = await callModel(buildPrompt(dependencies, adapter, context), SYSTEM_PROMPT, apiKey, providerHint, token);
  return parseFindings(raw, dependencies.rawCode);
}

function buildPrompt(deps: DependencyMetadata, adapter: LanguageAdapter, context: string): string {
  const subject = deps.isMethod ? `the "${deps.functionName}" method of class "${deps.className}"` : `the "${deps.functionName}" function`;
  return `Review ${subject} (${adapter.displayName}) below for concrete, specific bugs, edge-case failures, and correctness issues — not style nitpicks. For each issue, identify the 1-indexed line number WITHIN THE "Code:" BLOCK below (its own first line counts as line 1), a severity, and a one-sentence message.\n\nReturn ONLY a JSON array (no markdown fences, no prose) shaped exactly like:\n[{"line": number, "severity": "error" | "warning" | "info", "message": string}]\n\nUse "error" only for things that will definitely produce wrong output or crash on plausible inputs. Use "warning" for likely bugs or unhandled edge cases. Use "info" for real but minor issues. If there is nothing worth flagging, return [].\n\nMetadata: ${JSON.stringify(deps)}\n\nRelevant workspace context:\n${context || "No indexed context found."}\n\nCode:\n${deps.rawCode}`;
}
