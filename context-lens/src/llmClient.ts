import * as vscode from "vscode";

export type ProviderHint = "openai" | "anthropic" | "gemini" | undefined;

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const GEMINI_API_ROOT = "https://generativelanguage.googleapis.com/v1beta";

export function resolveApiKey(settings: vscode.WorkspaceConfiguration): { apiKey: string; providerHint: ProviderHint } {
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export async function callModel(prompt: string, systemPrompt: string, apiKey: string, providerHint: ProviderHint, token?: vscode.CancellationToken): Promise<string> {
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
