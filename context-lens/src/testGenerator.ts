import * as vscode from "vscode";
import { DependencyMetadata } from "./astExtractor.js";
import { WorkspaceRagIndex } from "./ragEngine.js";
import { runPythonTests, TestRunCancelledError } from "./testRunner.js";

export interface GenerationResult { tests: string; attempts: number; analysis: string; }

const TEST_SYSTEM_PROMPT = "You are a meticulous Python test engineer.";
const ANALYSIS_SYSTEM_PROMPT = "You are a meticulous Python code reviewer. Be concise and specific.";
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const GEMINI_API_ROOT = "https://generativelanguage.googleapis.com/v1beta";

export async function synthesizeVerifiedTests(
  sourceCode: string, dependencies: DependencyMetadata, index: WorkspaceRagIndex,
  report: (message: string) => void, token?: vscode.CancellationToken
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
    throwIfCancelled(token);
    report(`Generating tests (attempt ${attempt}/${maxRetries})...`);
    const tests = cleanCode(await callModel(buildTestPrompt(sourceCode, dependencies, testContext, previousFailure), TEST_SYSTEM_PROMPT, apiKey, providerHint, token));
    if (!tests) throw new Error("The model returned no Python test code.");
    throwIfCancelled(token);
    report(`Verifying in sandbox (attempt ${attempt}/${maxRetries})...`);
    const result = await runPythonTests(sourceCode, tests, pythonPath, token).catch((error) => {
      if (error instanceof TestRunCancelledError) throw new vscode.CancellationError();
      throw error;
    });
    if (result.passed) {
      throwIfCancelled(token);
      report("Analyzing function for potential issues...");
      const analysisContext = index.retrieveContext(dependencies, sourceCode, { limit: 6, preferTestArtifacts: false });
      const analysis = (await callModel(buildAnalysisPrompt(sourceCode, dependencies, tests, analysisContext), ANALYSIS_SYSTEM_PROMPT, apiKey, providerHint, token)).trim();
      return { tests, attempts: attempt, analysis };
    }
    previousFailure = result.output;
  }
  throw new Error(`Unable to generate passing tests after ${maxRetries} attempts.\n${previousFailure}`);
}

function throwIfCancelled(token?: vscode.CancellationToken): void {
  if (token?.isCancellationRequested) throw new vscode.CancellationError();
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

function describeSubject(deps: DependencyMetadata): string {
  return deps.isMethod ? `the \`${deps.functionName}\` method of class \`${deps.className}\`` : `the \`${deps.functionName}\` function`;
}

function buildTestPrompt(source: string, deps: DependencyMetadata, context: string, previousFailure: string): string {
  const focusNote = deps.isMethod
    ? `The code below is a full Python class. Focus tests specifically on ${describeSubject(deps)}; instantiate the class as needed (inspect its constructor for required arguments) rather than calling the method standalone.`
    : deps.isNested
      ? `The code below defines ${describeSubject(deps)} nested inside another function — it is not independently callable from outside. Write tests that exercise it indirectly by calling the enclosing function(s) with inputs that reach it, or if it truly cannot be observed from outside, say so in a comment and test whatever of the enclosing behavior you can instead.`
      : `The code below is a single Python function, ${describeSubject(deps)}.`;
  return `Write Python unittest tests for the code below. ${focusNote} Return ONLY runnable Python code: imports, test classes, and tests. Do not repeat the code. It is injected into the same file as your tests. Do not make network, filesystem, or subprocess calls.\n\nMetadata: ${JSON.stringify(deps)}\n\nRelevant workspace context:\n${context || "No indexed context found."}\n\nCode:\n${source}${previousFailure ? `\n\nPrevious test failure; repair it exactly:\n${previousFailure}` : ""}`;
}

function buildAnalysisPrompt(source: string, deps: DependencyMetadata, tests: string, context: string): string {
  const subject = describeSubject(deps);
  return `The code below now has passing unit tests focused on ${subject}. Review ${subject} (not the tests) for:\n1. Bugs and edge cases the tests don't cover.\n2. Duplicate or near-duplicate logic already implemented elsewhere in the codebase context below (name the file/function if so).\n3. Inconsistency with naming, error-handling, or type-hint conventions used elsewhere in the codebase context below.\n4. Concrete improvements.\nReply in plain English as a short bulleted list, grouped under those categories only where you have something to say. If you find nothing worth flagging in a category, omit it. If there is nothing to flag at all, say so in one line.\n\nMetadata: ${JSON.stringify(deps)}\n\nCode:\n${source}\n\nPassing tests:\n${tests}\n\nRelevant workspace context (for duplicate-logic and convention checks):\n${context || "No indexed context found."}`;
}

async function callModel(prompt: string, systemPrompt: string, apiKey: string, providerHint: ProviderHint, token?: vscode.CancellationToken): Promise<string> {
  const config = vscode.workspace.getConfiguration("contextLens");
  const baseUrl = config.get<string>("apiBaseUrl", "https://api.openai.com/v1").replace(/\/$/, "");
  const model = config.get<string>("model", "gpt-4.1-mini");
  const temperature = clamp(config.get<number>("temperature", 0.1), 0, 2);
  const maxOutputTokens = Math.max(1, config.get<number>("maxOutputTokens", 4096));

  const controller = new AbortController();
  const subscription = token?.onCancellationRequested(() => controller.abort());
  try {
    if (isAnthropic(apiKey, baseUrl, providerHint)) {
      const response = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION },
        signal: controller.signal,
        body: JSON.stringify({
          model, max_tokens: maxOutputTokens, temperature, system: systemPrompt,
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
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature, maxOutputTokens }
        })
      });
      if (!response.ok) throw new Error(`Model API request failed (${response.status}): ${await response.text()}`);
      const body = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      return body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({ model, temperature, max_tokens: maxOutputTokens, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: prompt }] })
    });
    if (!response.ok) throw new Error(`Model API request failed (${response.status}): ${await response.text()}`);
    const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    return body.choices?.[0]?.message?.content ?? "";
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new vscode.CancellationError();
    throw error;
  } finally {
    subscription?.dispose();
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function cleanCode(value: string): string {
  const block = value.match(/```(?:python)?\s*([\s\S]*?)```/i);
  return (block?.[1] ?? value).trim();
}
