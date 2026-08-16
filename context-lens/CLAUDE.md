# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

ContextLens is a VS Code extension that adds a "🧪 Generate & Verify Tests" CodeLens above Python
function definitions. Selecting it sends the function (plus lightweight static-analysis metadata and
retrieved workspace context) to an OpenAI-compatible chat-completions endpoint, the native Anthropic
Messages API, or the native Google Gemini API, asks it to write `unittest` tests, and actually runs
those tests locally with `python3 -m unittest` in a temp directory, retrying
(`contextLens.maxRetries`, default 3) if they fail, before showing the verified tests to the user.

## Architecture

Entry point: `src/extension.ts` — registers the CodeLens provider and the `contextLens.generateTest`
command, and wires the modules below together. There is no other glue code; each module below is
otherwise independent and unit-testable in isolation.

- `src/astExtractor.ts` — regex-based (no Python parser) extraction of a function/method's name,
  parameter types, return type, and which of the document's imports the code actually uses. Given a
  `focusSymbol`, it locates that specific `def` inside the passed-in source slice (which may be a
  function, a whole class, or a whole outer function containing a nested `def`) and walks backward
  through the *full* document text to detect an enclosing `class`, setting `className`/`isMethod` on
  the returned `DependencyMetadata`; `isNested` is true when indented but not a class method (i.e. a
  closure inside another function). Parameter parsing (`splitTopLevel`) is bracket-depth-aware so
  `def f(a: List[int, str] = [])` doesn't get mis-split on the inner comma, and signature/body
  extraction accounts for multi-line signatures (the body can't start until after the closing `):`
  line, wherever that falls).
- `src/codeLensProvider.ts` — finds Python `def`/`async def` lines via regex and computes each
  block's range by indentation, not AST. For a top-level (`indent === 0`) function it slices just
  that function. For an indented `def`, it climbs ancestors via `findOuterContainer` until it hits
  a `class` line (method — slice the whole class so `self` resolves) or indentation 0 (a plain
  nested function — slice the whole outer function it's nested inside), passing the target's own
  name as a second CodeLens command argument either way.
- `src/ragEngine.ts` — `WorkspaceRagIndex` walks the workspace for `.py`/`.pyi` files (skipping
  `.git`, `node_modules`, `.venv`, `venv`, `__pycache__`, `dist`, `build`), splits each file into
  per-function/class chunks (module-level code becomes its own chunk; whole file as fallback if no
  top-level `def`/`class` is found), classifies each file as test/fixture/model/source, and scores
  chunks by term-frequency overlap (capped per term, plus a symbol-exact-match bonus) to retrieve the
  most relevant chunks for a given function. `retrieveContext` takes a `preferTestArtifacts` option —
  `true` (the default, used for test generation) biases toward existing tests/fixtures; `false` (used
  for the post-verification analysis pass) does not, since that pass is looking for duplicate logic
  and convention mismatches in *source*, not test scaffolding. No embeddings, no external services,
  nothing persisted to disk.
- `src/testGenerator.ts` — `synthesizeVerifiedTests` retrieves RAG context, builds the prompt, and
  routes the request to one of three providers, checked in order: the Anthropic Messages API
  (`apiKey` starts with `sk-ant-` or `apiBaseUrl` contains `anthropic.com`), the native Gemini
  `generateContent` API (`apiKey` starts with `AIza` or `apiBaseUrl` contains
  `generativelanguage.googleapis.com` without `/openai`), or an OpenAI-compatible chat-completions
  endpoint otherwise (this also covers Gemini's OpenAI-compat shim if a user points `apiBaseUrl` at
  `.../v1beta/openai`). `temperature`/`maxOutputTokens` settings are applied per-provider. It then
  strips markdown code fences from the response, runs the result through `testRunner`, and on
  failure feeds the failure output back into the next attempt (up to `contextLens.maxRetries`,
  default 3). Accepts an optional `vscode.CancellationToken`: checked between steps via
  `throwIfCancelled` (throws `vscode.CancellationError`), and threaded into each `fetch` via an
  `AbortController` bridged to `token.onCancellationRequested`.
- `src/testRunner.ts` — writes source + generated tests to a temp file and runs
  `python3 -m unittest -v` on it with a 10s timeout via raw (non-promisified) `execFile` so the
  child process handle can be `.kill()`ed if the optional cancellation signal fires; throws
  `TestRunCancelledError` in that case (caught and re-thrown as `vscode.CancellationError` by
  `testGenerator.ts`, since this module deliberately doesn't import `vscode`).

## Build & verify

```bash
npm install
npm run compile   # tsc --noEmit, then bundles src/extension.ts -> dist/extension.js via esbuild
npm run lint       # eslint src --ext .ts
npm run watch      # esbuild --watch, used by the "Run Extension" launch config
```

`npm test` runs `compile` then `test:unit`. `npm run test:unit` runs `astExtractor.test.ts` and
`ragEngine.test.ts` (co-located under `src/`, `node:test` + `node:assert/strict`, executed via
`node --import tsx --test src/*.test.ts` — no build step needed for the tests themselves). These are
the only two modules with no `vscode` import, so they're the only ones with unit coverage;
`codeLensProvider.ts`, `testGenerator.ts`, and `extension.ts` depend on the `vscode` module and need
the Extension Development Host (F5 in VS Code, or the "Run Extension" launch config) to exercise end
to end. `*.test.ts` files are excluded from the packaged `.vsix` via `.vscodeignore`.

Always run `npm run compile` and `npm run lint` after touching `src/`.

## Conventions worth preserving

- No native binaries, no bundled Python parser, no vector DB / embeddings API — the whole point of
  this project is to stay dependency-light and work entirely with locally-available tooling
  (`python3` on PATH) plus one HTTP call to a user-configured chat-completions endpoint.
- Settings live under the `contextLens.*` namespace in `package.json`'s `contributes.configuration`
  (`apiKey`, `apiBaseUrl`, `model`, `pythonPath`, `maxRetries`, `temperature`, `maxOutputTokens`,
  `provider`). Read them via `vscode.workspace.getConfiguration("contextLens")`, not hardcoded
  values.
- `apiKey` falls back to the `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `GOOGLE_API_KEY` /
  `OPENAI_API_KEY` environment variables, in that order, when the setting is blank (see
  `resolveApiKey` in `testGenerator.ts`).
- Keep modules importable/testable without a running VS Code instance where possible — only
  `codeLensProvider.ts`, `testGenerator.ts`, and `extension.ts` should import `vscode`.
- Generated/verified tests are never written back into the user's source tree automatically; they're
  opened as an untitled document for the user to review and save themselves.
