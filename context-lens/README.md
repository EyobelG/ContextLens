# ContextLens

A VS Code extension that adds a **"🧪 Generate & Verify Tests"** CodeLens above Python function
definitions. Selecting it:

1. Extracts the function's signature and used imports (no Python parser required).
2. Retrieves relevant context from your workspace via a lightweight, embeddings-free RAG index
   (per-function/class chunking, term-frequency scoring).
3. Asks an LLM (OpenAI-compatible, Anthropic, or Google Gemini) to write `unittest` tests.
4. Actually **runs** those tests locally with `python3 -m unittest` in a sandboxed temp directory.
5. If they fail, feeds the failure back to the model and retries (up to `contextLens.maxRetries`,
   default 3).
6. Once tests pass, asks the model for a short analysis of the function — bugs, uncovered edge
   cases, duplicate logic elsewhere in your codebase, and convention mismatches — using a second,
   source-biased RAG retrieval pass.
7. Opens the verified tests (with the analysis as a leading comment block) in a new editor tab.
   Nothing is ever written back into your source tree automatically.

## Setup

```bash
npm install
npm run compile
```

Then press `F5` in VS Code to launch an Extension Development Host, or package + install a `.vsix`
(see `AGENTS.md` for both workflows).

Configure under **Settings → ContextLens**:

| Setting | Purpose |
|---|---|
| `contextLens.apiKey` | API key. Falls back to `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `GOOGLE_API_KEY` / `OPENAI_API_KEY` env vars. |
| `contextLens.provider` | `auto` / `openai` / `anthropic` / `gemini`. Set explicitly if your key doesn't match the expected prefix. |
| `contextLens.apiBaseUrl` | OpenAI-compatible base URL (ignored for Anthropic/Gemini). |
| `contextLens.model` | Model name, e.g. `gemini-2.5-flash`, `claude-sonnet-4-5`, `gpt-4.1-mini`. |
| `contextLens.pythonPath` | Python executable used to run generated tests. |
| `contextLens.maxRetries` | Generate-and-verify attempts before giving up. |

See `CLAUDE.md` for architecture details and `AGENTS.md` for build/lint/test commands.

## Roadmap / next todos

Roughly in priority order:

- [ ] **Automated unit tests.** `astExtractor.ts` and `ragEngine.ts` have zero `vscode` dependency
      and are trivially testable with `node:test` — currently there's no coverage at all.
- [ ] **Class-method support.** `astExtractor.ts` only matches bare `def`/`async def` and doesn't
      capture the enclosing class or `self`/`cls` context, so generating tests for a method (not a
      free function) will likely produce code that can't actually be verified in isolation.
- [ ] **Stale RAG index.** `extension.ts` builds the workspace index once per workspace root and
      caches it in memory for the life of the extension host — edits to other files after that
      won't be reflected in retrieval until the window is reloaded. Needs a file-watcher to
      invalidate/incrementally update the cached chunks.
- [ ] **`.vscodeignore`.** `vsce package` currently bundles `src/`, `.vscode/`, `esbuild.js`, etc.
      into the `.vsix` — none of that is needed at runtime, only `dist/` and `package.json`. Add a
      `.vscodeignore` to shrink the package.
- [ ] **LICENSE file.** `vsce` already warns about this; needed before any real distribution.
- [ ] **Cancellable progress.** The generate-and-verify loop currently can't be cancelled once
      started; `vscode.window.withProgress` is called with `cancellable: false`. Long-running or
      stuck model calls have no escape hatch besides closing the window.
- [ ] **Configurable temperature / max tokens.** Currently hardcoded (`temperature: 0.1`,
      `max_tokens: 4096` for Anthropic) in `testGenerator.ts` — fine as defaults, but large
      functions could benefit from a configurable ceiling.
- [ ] **CI.** No GitHub Actions workflow runs `npm run compile` / `npm run lint` on push — nothing
      currently prevents a broken build from being merged.
- [ ] **Optional semantic RAG.** Current retrieval is lexical/term-frequency by design (see
      `CLAUDE.md`'s "no embeddings" convention) — fine for small-to-medium repos, but a large
      codebase would benefit from an opt-in embeddings-backed mode for better recall.
- [ ] **Marketplace metadata.** `publisher` is unset (installs as `undefined_publisher.context-lens`)
      — needs a real publisher ID, icon, and `README.md` gallery banner before publishing to the
      VS Code Marketplace.
