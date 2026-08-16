# AGENTS.md

## Project

ContextLens — a VS Code extension for Python, JavaScript, and TypeScript. It shows two CodeLenses
above every function/method it can find:

- **Generate & Verify Tests** — generates tests via an OpenAI-compatible LLM endpoint, the native
  Anthropic Messages API, or the native Google Gemini API, verifies them by actually running them
  in a sandboxed temp directory (`python3 -m unittest` / Node's built-in `node --test`), and retries
  (`contextLens.maxRetries`, default 3) on failure before surfacing the tests to the user.
- **Explain Issues** — asks the model for structured findings and publishes them as real
  `vscode.Diagnostic`s in the Problems panel.

## Layout

| File | Role | Imports `vscode`? |
|---|---|---|
| `src/extension.ts` | Activation entry point; registers CodeLens provider + both commands + diagnostic collection | yes |
| `src/codeLensProvider.ts` | Looks up the adapter for a document, turns `adapter.findCodeLensTargets` into CodeLenses | yes |
| `src/languages/types.ts` | `LanguageAdapter` / `DependencyMetadata` / `CodeLensTarget` interfaces | no |
| `src/languages/python.ts` | Indentation-based extraction, chunking, classification for Python | no |
| `src/languages/javascript.ts` | Brace-based extraction, chunking, classification for JS/TS (`javascriptAdapter` + `typescriptAdapter`) | no |
| `src/languages/registry.ts` | Maps `vscode` languageId → adapter | no |
| `src/ragEngine.ts` | Adapter-driven workspace walk/chunk/score for RAG context retrieval | no |
| `src/llmClient.ts` | Provider-agnostic `callModel`/`resolveApiKey`, shared by generation and diagnostics | yes |
| `src/testGenerator.ts` | Builds adapter-aware prompts, drives the verify-and-retry loop | yes |
| `src/testRunner.ts` | Runs generated tests via `adapter.runArgs` in a temp dir | no |
| `src/diagnosticsGenerator.ts` | Calls the LLM for structured issue findings | yes |
| `src/diagnosticsParser.ts` | Parses/validates/clamps the model's JSON findings | no |

## Setup

```bash
npm install
```

## Build

```bash
npm run compile   # tsc --noEmit && esbuild bundle -> dist/extension.js
```

## Lint

```bash
npm run lint       # eslint src --ext .ts
```

## Test

```bash
npm test           # compile, then run unit tests
npm run test:unit  # node --import tsx --test src/*.test.ts src/languages/*.test.ts (no build step required)
```

Unit tests exist only for modules with no `vscode` import: `languages/python.ts`,
`languages/javascript.ts`, `ragEngine.ts`, `diagnosticsParser.ts`. To exercise the rest of the
extension: open this folder in VS Code and press F5 (or use the "Run Extension" launch config in
`.vscode/launch.json`), which runs `npm: watch` and opens an Extension Development Host window.
Open a `.py`, `.js`, or `.ts` file there to see the CodeLenses.

## Before committing

Run, in order:

```bash
npm run compile
npm run lint
npm run test:unit
```

All three must pass with no errors. There is no CI config in this repo yet, so these are the only
automated gates — treat them as required.

## Conventions

- Keep `languages/python.ts`, `languages/javascript.ts`, `ragEngine.ts`, and `diagnosticsParser.ts`
  free of `vscode` imports so they stay testable outside the Extension Development Host.
- User-configurable behavior goes through `vscode.workspace.getConfiguration("contextLens")`
  (`apiKey`, `apiBaseUrl`, `model`, `pythonPath`, `nodePath`, `maxRetries`, `temperature`,
  `maxOutputTokens`, `provider`), matching `contributes.configuration` in `package.json` — don't
  hardcode values that are already exposed as settings.
- `apiKey` falls back to `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `GOOGLE_API_KEY` / `OPENAI_API_KEY`
  env vars (in that order) when blank. Provider routing is inferred in `llmClient.ts` (key prefix or
  `apiBaseUrl` substring — see that file's `isAnthropic`/`isGemini`), not per-language.
- No new runtime dependencies without a strong reason: this project deliberately avoids native
  binaries, bundled parsers, and vector DB/embeddings services — when adding a language, prefer its
  stdlib test runner over anything requiring an install.
- Adding a language means implementing one `LanguageAdapter` (see `languages/types.ts`) and
  registering it in `languages/registry.ts` — the rest of the pipeline (CodeLens, RAG, prompting,
  sandbox execution) should need zero language-specific branches. If you're tempted to add
  `if (adapter.id === "...")` outside a language adapter file, put that behavior on the adapter
  interface instead (see `lineCommentPrefix` for the pattern).
