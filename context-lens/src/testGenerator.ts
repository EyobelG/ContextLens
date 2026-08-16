import * as vscode from "vscode";
import { callModel, resolveApiKey } from "./llmClient.js";
import { DependencyMetadata, LanguageAdapter } from "./languages/types.js";
import { WorkspaceRagIndex } from "./ragEngine.js";
import { runTests, TestRunCancelledError } from "./testRunner.js";

export interface GenerationResult { tests: string; attempts: number; analysis: string; }

const ANALYSIS_SYSTEM_PROMPT = "You are a meticulous code reviewer. Be concise and specific.";

export async function synthesizeVerifiedTests(
  sourceCode: string, dependencies: DependencyMetadata, adapter: LanguageAdapter, index: WorkspaceRagIndex,
  report: (message: string) => void, token?: vscode.CancellationToken
): Promise<GenerationResult> {
  const settings = vscode.workspace.getConfiguration("contextLens");
  const { apiKey, providerHint } = resolveApiKey(settings);
  if (!apiKey) throw new Error("ContextLens requires contextLens.apiKey (or the ANTHROPIC_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY environment variable) to generate tests.");
  report("Retrieving relevant codebase context...");
  const testContext = index.retrieveContext(dependencies, sourceCode, { limit: 5, preferTestArtifacts: true });
  const runnerPath = settings.get<string>(adapter.runnerSettingKey, adapter.defaultRunnerPath);
  const maxRetries = Math.max(1, settings.get<number>("maxRetries", 3));
  const testSystemPrompt = `You are a meticulous ${adapter.displayName} test engineer.`;
  let previousFailure = "";
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    throwIfCancelled(token);
    report(`Generating tests (attempt ${attempt}/${maxRetries})...`);
    const tests = cleanCode(await callModel(buildTestPrompt(sourceCode, dependencies, adapter, testContext, previousFailure), testSystemPrompt, apiKey, providerHint, token), adapter);
    if (!tests) throw new Error("The model returned no test code.");
    throwIfCancelled(token);
    report(`Verifying in sandbox (attempt ${attempt}/${maxRetries})...`);
    const result = await runTests(sourceCode, tests, adapter, runnerPath, token).catch((error) => {
      if (error instanceof TestRunCancelledError) throw new vscode.CancellationError();
      throw error;
    });
    if (result.passed) {
      throwIfCancelled(token);
      report("Analyzing code for potential issues...");
      const analysisContext = index.retrieveContext(dependencies, sourceCode, { limit: 6, preferTestArtifacts: false });
      const analysis = (await callModel(buildAnalysisPrompt(sourceCode, dependencies, adapter, tests, analysisContext), ANALYSIS_SYSTEM_PROMPT, apiKey, providerHint, token)).trim();
      return { tests, attempts: attempt, analysis };
    }
    previousFailure = result.output;
  }
  throw new Error(`Unable to generate passing tests after ${maxRetries} attempts.\n${previousFailure}`);
}

function throwIfCancelled(token?: vscode.CancellationToken): void {
  if (token?.isCancellationRequested) throw new vscode.CancellationError();
}

function describeSubject(deps: DependencyMetadata): string {
  return deps.isMethod ? `the \`${deps.functionName}\` method of class \`${deps.className}\`` : `the \`${deps.functionName}\` function`;
}

function buildTestPrompt(source: string, deps: DependencyMetadata, adapter: LanguageAdapter, context: string, previousFailure: string): string {
  const focusNote = deps.isMethod
    ? `The code below is a full ${adapter.displayName} class. Focus tests specifically on ${describeSubject(deps)}; instantiate the class as needed (inspect its constructor for required arguments) rather than calling the method standalone.`
    : deps.isNested
      ? `The code below defines ${describeSubject(deps)} nested inside another function — it is not independently callable from outside. Write tests that exercise it indirectly by calling the enclosing function(s) with inputs that reach it, or if it truly cannot be observed from outside, say so in a comment and test whatever of the enclosing behavior you can instead.`
      : `The code below is a single ${adapter.displayName} function, ${describeSubject(deps)}.`;
  return `Write ${adapter.displayName} tests for the code below using the ${adapter.frameworkName} framework. ${focusNote} Return ONLY runnable ${adapter.displayName} code: imports, test setup, and tests. Do not repeat the code. It is injected into the same file as your tests. Do not make network, filesystem, or subprocess calls.\n\nMetadata: ${JSON.stringify(deps)}\n\nRelevant workspace context:\n${context || "No indexed context found."}\n\nCode:\n${source}${previousFailure ? `\n\nPrevious test failure; repair it exactly:\n${previousFailure}` : ""}`;
}

function buildAnalysisPrompt(source: string, deps: DependencyMetadata, adapter: LanguageAdapter, tests: string, context: string): string {
  const subject = describeSubject(deps);
  return `The ${adapter.displayName} code below now has passing unit tests focused on ${subject}. Review ${subject} (not the tests) for:\n1. Bugs and edge cases the tests don't cover.\n2. Duplicate or near-duplicate logic already implemented elsewhere in the codebase context below (name the file/function if so).\n3. Inconsistency with naming, error-handling, or type conventions used elsewhere in the codebase context below.\n4. Concrete improvements.\nReply in plain English as a short bulleted list, grouped under those categories only where you have something to say. If you find nothing worth flagging in a category, omit it. If there is nothing to flag at all, say so in one line.\n\nMetadata: ${JSON.stringify(deps)}\n\nCode:\n${source}\n\nPassing tests:\n${tests}\n\nRelevant workspace context (for duplicate-logic and convention checks):\n${context || "No indexed context found."}`;
}

function cleanCode(value: string, adapter: LanguageAdapter): string {
  const block = value.match(adapter.codeFencePattern);
  return (block?.[1] ?? value).trim();
}
