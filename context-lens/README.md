# ContextLens: Python Tests

A VS Code extension that adds two CodeLens actions above every function, method, and (for
Python) nested function/method it can find, in **Python, JavaScript, and TypeScript** files:

## 🧪 Generate & Verify Tests

1. Extracts the function/method's signature and used imports (regex-based, no external parser).
2. Retrieves relevant context from your workspace via a lightweight, embeddings-free RAG index
   (per-function/class chunking, term-frequency scoring, scoped to the file's language).
3. Asks an LLM (OpenAI-compatible, Anthropic, or Google Gemini) to write tests — `unittest` for
   Python, Node's built-in `node:test` for JavaScript/TypeScript (no extra test-framework install
   required either way).
4. Actually **runs** those tests locally in a sandboxed temp directory (`python3 -m unittest`, or
   `node --test` / `node --experimental-strip-types --test` for TS).
5. If they fail, feeds the failure back to the model and retries (up to `contextLens.maxRetries`,
   default 3).
6. Once tests pass, asks the model for a short analysis of the code — bugs, uncovered edge cases,
   duplicate logic elsewhere in your codebase, and convention mismatches — using a second,
   source-biased RAG retrieval pass.
7. Opens the verified tests (with the analysis as a leading comment block) in a new editor tab.
   Nothing is ever written back into your source tree automatically.

## 🔎 Explain Issues

A lighter-weight companion action for when you don't need generated tests, just a second opinion:
asks the model to review the function/method for concrete bugs and edge cases (same RAG context as
above), and surfaces findings as real diagnostics in the **Problems panel** — with squiggly
underlines at the relevant lines — instead of a wall of text in a separate file.

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
| `contextLens.pythonPath` | Python executable used to run generated Python tests. |
| `contextLens.nodePath` | Node executable used to run generated JavaScript/TypeScript tests. |
| `contextLens.maxRetries` | Generate-and-verify attempts before giving up. |
| `contextLens.temperature` | Sampling temperature for both test generation and analysis calls (default `0.1`). |
| `contextLens.maxOutputTokens` | Max output tokens requested per model call (default `4096`) — raise this for very large functions/classes. |

The progress notification shown while generating is cancellable — click the ✕ to stop mid-run;
it aborts the in-flight model request and kills the sandboxed test process.

**TypeScript note:** native type-stripping requires Node 22.6+ (behind `--experimental-strip-types`,
always passed) or Node 23.6+ (unflagged, the flag is simply ignored). Earlier Node versions will
fail to verify TypeScript tests — Python and JavaScript are unaffected.

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

- **Nested functions** (a `def`/`function` inside another one) get a CodeLens, but since they
  aren't independently callable, the model is prompted to test them indirectly through the
  enclosing function — results are best-effort and depend on the nesting.
- **JS/TS parsing is regex/brace-based, not a real parser.** Common patterns (function
  declarations, arrow functions assigned to a variable or class field, class methods) are handled;
  exotic syntax (decorators changing method shape, functions defined inside template-literal
  interpolations) may not be detected. Same philosophy as the Python side — no bundled parser.
- **displayName still says "Python Tests"** even though JS/TS are now supported — a rename would
  require another Marketplace collision check, left as a deliberate follow-up rather than done
  unprompted.
- **No CI.** Compile/lint/test aren't enforced automatically on push.
- **Lexical RAG only.** Retrieval is term-frequency based, not embeddings — fine for small/medium
  repos, weaker on very large ones.
- **Explain Issues diagnostics are replaced, not merged**, per file — running it again on a
  different function in the same file clears the previous findings.
