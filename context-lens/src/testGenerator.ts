import * as vscode from "vscode";
import { DependencyMetadata } from "./astExtractor.js";
import { WorkspaceRagIndex } from "./ragEngine.js";
import { runPythonTests } from "./testRunner.js";

export interface GenerationResult { tests: string; attempts: number; analysis: string; }

const TEST_SYSTEM_PROMPT = "You are a meticulous Python test engineer.";
const ANALYSIS_SYSTEM_PROMPT = "You are a meticulous Python code reviewer. Be concise and specific.";
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const GEMINI_API_ROOT = "https://generativelanguage.googleapis.com/v1beta";

export async function synthesizeVerifiedTests(
  sourceCode: string, dependencies: DependencyMetadata, index: WorkspaceRagIndex,
  report: (message: string) => void
): Promise<GenerationResult> {
  const settings = vscode.workspace.getConfiguration("contextLens");
  const { apiKey, providerHint } = resolveApiKey(settings);
  if (!apiKey) throw new Error("ContextLens requires contextLens.apiKey (or the ANTHROPIC_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY environment variable) to generate tests.");
  report("Retrieving relevant codebase context...");
  const testContext = index.retrieveContext(dependencies, sourceCode, { limit: 5, preferTestArtifacts: true });
  const pythonPath = settings.get<string>("pythonPath", "python3");
  const maxRetries = Math.max(1, settings.get<number>("maxRetries", 3));
  let previousFailure = "";
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    report(`Generating tests (attempt ${attempt}/${maxRetries})...`);
    const tests = cleanCode(await callModel(buildTestPrompt(sourceCode, dependencies, testContext, previousFailure), TEST_SYSTEM_PROMPT, apiKey, providerHint));
    if (!tests) throw new Error("The model returned no Python test code.");
    report(`Verifying in sandbox (attempt ${attempt}/${maxRetries})...`);
    const result = await runPythonTests(sourceCode, tests, pythonPath);
    if (result.passed) {
      report("Analyzing function for potential issues...");
      const analysisContext = index.retrieveContext(dependencies, sourceCode, { limit: 6, preferTestArtifacts: false });
      const analysis = (await callModel(buildAnalysisPrompt(sourceCode, dependencies, tests, analysisContext), ANALYSIS_SYSTEM_PROMPT, apiKey, providerHint)).trim();
      return { tests, attempts: attempt, analysis };
    }
    previousFailure = result.output;
  }
  throw new Error(`Unable to generate passing tests after ${maxRetries} attempts.\n${previousFailure}`);
}

type ProviderHint = "openai" | "anthropic" | "gemini" | undefined;

function resolveApiKey(settings: vscode.WorkspaceConfiguration): { apiKey: string; providerHint: ProviderHint } {
  const configuredProvider = settings.get<string>("provider", "auto");
  const explicitHint: ProviderHint = configuredProvider === "openai" || configuredProvider === "anthropic" || configuredProvider === "gemini" ? configuredProvider : undefined;

  const configuredKey = settings.get<string>("apiKey", "").trim();
  if (configuredKey) return { apiKey: configuredKey, providerHint: explicitHint };

  if (process.env.ANTHROPIC_API_KEY) return { apiKey: process.env.ANTHROPIC_API_KEY.trim(), providerHint: explicitHint ?? "anthropic" };
  if (process.env.GEMINI_API_KEY) return { apiKey: process.env.GEMINI_API_KEY.trim(), providerHint: explicitHint ?? "gemini" };
  if (process.env.GOOGLE_API_KEY) return { apiKey: process.env.GOOGLE_API_KEY.trim(), providerHint: explicitHint ?? "gemini" };
  if (process.env.OPENAI_API_KEY) return { apiKey: process.env.OPENAI_API_KEY.trim(), providerHint: explicitHint ?? "openai" };
  return { apiKey: "", providerHint: explicitHint };
}

function isAnthropic(apiKey: string, baseUrl: string, hint: ProviderHint): boolean {
  if (hint) return hint === "anthropic";
  return apiKey.startsWith("sk-ant-") || baseUrl.includes("anthropic.com");
}

function isGemini(apiKey: string, baseUrl: string, hint: ProviderHint): boolean {
  if (hint) return hint === "gemini";
  return apiKey.startsWith("AIza") || (baseUrl.includes("generativelanguage.googleapis.com") && !baseUrl.includes("/openai"));
}

function buildTestPrompt(source: string, deps: DependencyMetadata, context: string, previousFailure: string): string {
  return `Write Python unittest tests for the function below. Return ONLY runnable Python code: imports, test classes, and tests. Do not repeat the function. Tests run with the function injected into the same file. Do not make network, filesystem, or subprocess calls.\n\nFunction metadata: ${JSON.stringify(deps)}\n\nRelevant workspace context:\n${context || "No indexed context found."}\n\nFunction:\n${source}${previousFailure ? `\n\nPrevious test failure; repair it exactly:\n${previousFailure}` : ""}`;
}

function buildAnalysisPrompt(source: string, deps: DependencyMetadata, tests: string, context: string): string {
  return `The Python function below now has passing unit tests. Review the function itself (not the tests) for:\n1. Bugs and edge cases the tests don't cover.\n2. Duplicate or near-duplicate logic already implemented elsewhere in the codebase context below (name the file/function if so).\n3. Inconsistency with naming, error-handling, or type-hint conventions used elsewhere in the codebase context below.\n4. Concrete improvements.\nReply in plain English as a short bulleted list, grouped under those categories only where you have something to say. If you find nothing worth flagging in a category, omit it. If there is nothing to flag at all, say so in one line.\n\nFunction metadata: ${JSON.stringify(deps)}\n\nFunction:\n${source}\n\nPassing tests:\n${tests}\n\nRelevant workspace context (for duplicate-logic and convention checks):\n${context || "No indexed context found."}`;
}

async function callModel(prompt: string, systemPrompt: string, apiKey: string, providerHint: ProviderHint): Promise<string> {
  const config = vscode.workspace.getConfiguration("contextLens");
  const baseUrl = config.get<string>("apiBaseUrl", "https://api.openai.com/v1").replace(/\/$/, "");
  const model = config.get<string>("model", "gpt-4.1-mini");

  if (isAnthropic(apiKey, baseUrl, providerHint)) {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION },
      body: JSON.stringify({
        model, max_tokens: 4096, system: systemPrompt,
        messages: [{ role: "user", content: prompt }]
      })
    });
    if (!response.ok) throw new Error(`Model API request failed (${response.status}): ${await response.text()}`);
    const body = await response.json() as { content?: Array<{ type: string; text?: string }> };
    return body.content?.find((block) => block.type === "text")?.text ?? "";
  }

  if (isGemini(apiKey, baseUrl, providerHint)) {
    const response = await fetch(`${GEMINI_API_ROOT}/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1 }
      })
    });
    if (!response.ok) throw new Error(`Model API request failed (${response.status}): ${await response.text()}`);
    const body = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    return body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, temperature: 0.1, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: prompt }] })
  });
  if (!response.ok) throw new Error(`Model API request failed (${response.status}): ${await response.text()}`);
  const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return body.choices?.[0]?.message?.content ?? "";
}

function cleanCode(value: string): string {
  const block = value.match(/```(?:python)?\s*([\s\S]*?)```/i);
  return (block?.[1] ?? value).trim();
}
