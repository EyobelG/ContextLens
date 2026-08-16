# ContextLens: Python Tests

A VS Code extension that adds a **"🧪 Generate & Verify Tests"** CodeLens above Python function and
class-method definitions. Selecting it:

1. Extracts the function/method's signature and used imports (no Python parser required).
2. Retrieves relevant context from your workspace via a lightweight, embeddings-free RAG index
   (per-function/class chunking, term-frequency scoring).
3. Asks an LLM (OpenAI-compatible, Anthropic, or Google Gemini) to write `unittest` tests.
4. Actually **runs** those tests locally with `python3 -m unittest` in a sandboxed temp directory.
5. If they fail, feeds the failure back to the model and retries (up to `contextLens.maxRetries`,
   default 3).
6. Once tests pass, asks the model for a short analysis of the code — bugs, uncovered edge cases,
   duplicate logic elsewhere in your codebase, and convention mismatches — using a second,
   source-biased RAG retrieval pass.
7. Opens the verified tests (with the analysis as a leading comment block) in a new editor tab.
   Nothing is ever written back into your source tree automatically.

## Install

Search **"ContextLens: Python Tests"** in the VS Code Extensions view, or install directly:
[marketplace.visualstudio.com/items?itemName=eyobelg.context-lens-python](https://marketplace.visualstudio.com/items?itemName=eyobelg.context-lens-python)

## Setup

> **You need your own API key.** ContextLens does not ship with, embed, or proxy any API key —
> nothing is bundled into the extension. You must supply your own key from OpenAI, Anthropic, or
> Google (Gemini has a free tier — get one at [aistudio.google.com/apikey](https://aistudio.google.com/apikey)).
> Requests go straight from your machine to the provider you configure; ContextLens never sees or
> forwards your key anywhere else.

Configure under **Settings → ContextLens**:

| Setting | Purpose |
|---|---|
| `contextLens.apiKey` | API key. Falls back to `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `GOOGLE_API_KEY` / `OPENAI_API_KEY` env vars. |
| `contextLens.provider` | `auto` / `openai` / `anthropic` / `gemini`. Set explicitly if your key doesn't match the expected prefix. |
| `contextLens.apiBaseUrl` | OpenAI-compatible base URL (ignored for Anthropic/Gemini). |
| `contextLens.model` | Model name, e.g. `gemini-2.5-flash`, `claude-sonnet-4-5`, `gpt-4.1-mini`. |
| `contextLens.pythonPath` | Python executable used to run generated tests. |
| `contextLens.maxRetries` | Generate-and-verify attempts before giving up. |
| `contextLens.temperature` | Sampling temperature for both test generation and analysis calls (default `0.1`). |
| `contextLens.maxOutputTokens` | Max output tokens requested per model call (default `4096`) — raise this for very large functions/classes. |

The progress notification shown while generating is cancellable — click the ✕ to stop mid-run;
it aborts the in-flight model request and kills the sandboxed Python process.

## Contributing

```bash
npm install
npm run compile
npm test    # compile + unit tests
npm run lint
```

Press `F5` in VS Code to launch an Extension Development Host. See `CLAUDE.md` for architecture
details and `AGENTS.md` for the full build/lint/test/package workflow.

## Known limitations / roadmap

- **Nested functions** (a `def` inside another `def`) now get a CodeLens, but since they aren't
  independently callable, the model is prompted to test them indirectly through the enclosing
  function — results are best-effort and depend on the nesting.
- **No CI.** Compile/lint/test aren't enforced automatically on push.
- **Lexical RAG only.** Retrieval is term-frequency based, not embeddings — fine for small/medium
  repos, weaker on very large ones.
