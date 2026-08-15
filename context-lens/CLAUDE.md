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

- `src/astExtractor.ts` — regex-based (no Python parser) extraction of a function's name, parameter
  types, return type, and which of the document's imports the function body actually uses.
- `src/codeLensProvider.ts` — finds Python `def`/`async def` lines via regex and computes each
  function's body range by indentation, not AST, to place the CodeLens and slice the source to send.
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
  routes the request to one
  of three providers, checked in order: the Anthropic Messages API (`apiKey` starts with `sk-ant-` or
  `apiBaseUrl` contains `anthropic.com`), the native Gemini `generateContent` API (`apiKey` starts
  with `AIza` or `apiBaseUrl` contains `generativelanguage.googleapis.com` without `/openai`), or an
  OpenAI-compatible chat-completions endpoint otherwise (this also covers Gemini's OpenAI-compat
  shim if a user points `apiBaseUrl` at `.../v1beta/openai`). It then strips markdown code fences
  from the response, runs the result through `testRunner`, and on failure feeds the failure output
  back into the next attempt (up to `contextLens.maxRetries`, default 3).
- `src/testRunner.ts` — writes source + generated tests to a temp file and runs
  `python3 -m unittest -v` on it with a 10s timeout, then cleans up the temp directory.

## Build & verify

```bash
npm install
npm run compile   # tsc --noEmit, then bundles src/extension.ts -> dist/extension.js via esbuild
npm run lint       # eslint src --ext .ts
npm run watch      # esbuild --watch, used by the "Run Extension" launch config
```

`npm test` is currently just an alias for `npm run compile` — there are no unit tests yet. If you add
test coverage, prefer testing `astExtractor.ts` and `ragEngine.ts` directly since they have no VS Code
API dependency; `codeLensProvider.ts`, `testGenerator.ts`, and `extension.ts` depend on the `vscode`
module and need the Extension Development Host (F5 in VS Code, or the "Run Extension" launch config)
to exercise end to end.

Always run `npm run compile` and `npm run lint` after touching `src/`.

## Conventions worth preserving

- No native binaries, no bundled Python parser, no vector DB / embeddings API — the whole point of
  this project is to stay dependency-light and work entirely with locally-available tooling
  (`python3` on PATH) plus one HTTP call to a user-configured chat-completions endpoint.
- Settings live under the `contextLens.*` namespace in `package.json`'s `contributes.configuration`
  (`apiKey`, `apiBaseUrl`, `model`, `pythonPath`, `maxRetries`). Read them via
  `vscode.workspace.getConfiguration("contextLens")`, not hardcoded values.
- `apiKey` falls back to the `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `GOOGLE_API_KEY` /
  `OPENAI_API_KEY` environment variables, in that order, when the setting is blank (see
  `resolveApiKey` in `testGenerator.ts`).
- Keep modules importable/testable without a running VS Code instance where possible — only
  `codeLensProvider.ts`, `testGenerator.ts`, and `extension.ts` should import `vscode`.
- Generated/verified tests are never written back into the user's source tree automatically; they're
  opened as an untitled document for the user to review and save themselves.
