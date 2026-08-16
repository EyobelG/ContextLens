# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

ContextLens is a VS Code extension for Python, JavaScript, and TypeScript that adds two CodeLens
actions above every function/method it can find:

- **"🧪 Generate & Verify Tests"** — sends the function (plus static-analysis metadata and
  RAG-retrieved workspace context) to an LLM, asks it to write tests (`unittest` for Python,
  `node:test` for JS/TS — both are stdlib, no test-framework install required), actually runs them
  in a sandboxed temp directory, retries on failure (up to `contextLens.maxRetries`), and on success
  asks the model for a short bugs/duplication/convention analysis using a second RAG pass.
- **"🔎 Explain Issues"** — a lighter-weight companion: asks the model for structured findings
  (JSON) about the function and publishes them as real `vscode.Diagnostic`s in the Problems panel,
  instead of generating tests.

Both support OpenAI-compatible, Anthropic, and Google Gemini APIs.

## Architecture

Entry point: `src/extension.ts` — registers the CodeLens provider and both commands, and wires
everything below together.

### Language adapters (`src/languages/`)

Everything language-specific lives behind the `LanguageAdapter` interface (`src/languages/types.ts`):
finding functions/methods for CodeLens, extracting structured `DependencyMetadata` from a source
slice, chunking/classifying files for RAG, and how to run generated tests. `src/languages/registry.ts`
maps a `vscode.TextDocument`'s `languageId` to its adapter.

- `src/languages/python.ts` — indentation-based extraction (regex, no real parser). Given a
  `focusSymbol`, locates that `def` inside the passed-in slice (a function, a whole class, or a
  whole outer function containing a nested `def`) and walks backward through the *full* document
  text to detect an enclosing `class`. `isNested` is true when indented but not a class method (a
  closure inside another function). Parameter parsing is bracket-depth-aware
  (`def f(a: List[int, str] = [])` doesn't mis-split on the inner comma), and signature/body
  extraction accounts for multi-line signatures.
- `src/languages/javascript.ts` — brace-based extraction (also not a real parser). `maskNonCode`
  first blanks out string/template-literal/comment contents (preserving length/line breaks) so
  brace-matching and keyword regexes never get confused by braces or keywords inside a string.
  Detects `function name() {}`, arrow functions assigned via `const/let/var name = () => {}` (also
  catches class-field arrows like `onClick = () => {}`), `class Name {}`, and class methods (scanned
  within a class body at brace-depth 0, so nested closures inside a method aren't mistaken for
  sibling methods). Container resolution (which class or outer function to send as source) works by
  finding the tightest definition/class whose brace range contains the target — same conceptual
  design as Python's ancestor-climbing, just structural instead of indentation-based. Exports two
  adapters, `javascriptAdapter` and `typescriptAdapter`, that share all of this logic and differ
  only in file extensions/vscode language IDs and how the sandbox runs the result (`.mjs` needs no
  flags; `.ts` needs `--experimental-strip-types`, required on Node 22.6+, a no-op on 23.6+).
- `src/languages/registry.ts` — `getAdapterForLanguageId`, `SUPPORTED_VSCODE_LANGUAGE_IDS`.

### Core pipeline

- `src/codeLensProvider.ts` — thin `vscode`-glue layer: looks up the adapter for the document,
  calls `adapter.findCodeLensTargets(text)`, and turns each target into a pair of CodeLenses
  (generate tests / explain issues) sharing the same source slice.
- `src/ragEngine.ts` — `WorkspaceRagIndex` takes a `LanguageAdapter` in its constructor and walks
  the workspace for files matching `adapter.fileExtensionPattern` (skipping `.git`, `node_modules`,
  `.venv`, `venv`, `__pycache__`, `dist`, `build`), chunks via `adapter.splitIntoChunks`, classifies
  via `adapter.classifyFile`, and scores by term-frequency overlap using `adapter.stopwords` to
  filter language keywords from query terms (capped per term, plus a symbol-exact-match bonus).
  `retrieveContext`'s `preferTestArtifacts` option biases toward existing tests/fixtures for test
  generation, off for the duplicate-logic/convention analysis pass. No embeddings, nothing persisted
  to disk. `extension.ts` caches one index per `${workspaceRoot}::${adapter.id}` (a project may mix
  languages) and invalidates the relevant entries on `**/*.{py,pyi,js,jsx,mjs,cjs,ts,tsx}` changes.
- `src/llmClient.ts` — provider-agnostic `callModel`/`resolveApiKey`, shared by both
  `testGenerator.ts` and `diagnosticsGenerator.ts`. Routes to one of three providers, checked in
  order: Anthropic (`apiKey` starts with `sk-ant-` or `apiBaseUrl` contains `anthropic.com`), Gemini
  (`apiKey` starts with `AIza` or `apiBaseUrl` contains `generativelanguage.googleapis.com` without
  `/openai`), else OpenAI-compatible chat-completions. `temperature`/`maxOutputTokens` settings are
  applied per-provider. Threads an optional `vscode.CancellationToken` into each `fetch` via an
  `AbortController`, converting `AbortError` into `vscode.CancellationError`.
- `src/testGenerator.ts` — `synthesizeVerifiedTests(sourceCode, dependencies, adapter, index, report, token)`
  builds adapter-aware prompts (mentions the right language/framework, and notes when the target is
  nested/a method so the model knows how to reach it), strips code fences via `adapter.codeFencePattern`,
  runs the result through `testRunner`, and on failure feeds the failure output back into the next
  attempt.
- `src/testRunner.ts` — generic: writes `adapter.buildRunnableSource(sourceCode, testCode)` to a
  temp file named `test_generated${adapter.runnableFileExtension}` and runs
  `runnerPath adapter.runArgs(testFile)` via raw (non-promisified) `execFile` (10s timeout) so the
  child process can be `.kill()`ed on cancellation; throws `TestRunCancelledError` in that case
  (this module deliberately doesn't import `vscode`, so `testGenerator.ts` re-throws it as
  `vscode.CancellationError`).
- `src/diagnosticsGenerator.ts` / `src/diagnosticsParser.ts` — `explainIssues` asks the model for a
  strict JSON array (`[{line, severity, message}]`, line numbers 1-indexed relative to the target's
  own `rawCode`) and `parseFindings` (in the vscode-free `diagnosticsParser.ts`, for unit testing)
  parses/clamps/validates it defensively — invalid JSON or an unrecognized severity degrades
  gracefully rather than throwing. `extension.ts` maps each finding's relative line back to an
  absolute document line via `documentText.indexOf(dependencies.rawCode)` (works because `rawCode`
  is always an exact substring of the document) and publishes `vscode.Diagnostic`s to a
  `DiagnosticCollection`, replacing (not merging) that file's previous findings.

## Build & verify

```bash
npm install
npm run compile   # tsc --noEmit, then bundles src/extension.ts -> dist/extension.js via esbuild
npm run lint       # eslint src --ext .ts
npm run watch      # esbuild --watch, used by the "Run Extension" launch config
```

`npm test` runs `compile` then `test:unit`. `npm run test:unit` runs every `*.test.ts` under `src/`
and `src/languages/` via `node --import tsx --test` — no build step needed for the tests themselves.
Only modules with no `vscode` import have unit coverage: `languages/python.ts`, `languages/javascript.ts`,
`ragEngine.ts`, `diagnosticsParser.ts`. `codeLensProvider.ts`, `testGenerator.ts`,
`diagnosticsGenerator.ts`, `llmClient.ts`, and `extension.ts` depend on `vscode` and need the
Extension Development Host (F5, or the "Run Extension" launch config) to exercise end to end.
`*.test.ts` files are excluded from the packaged `.vsix` via `.vscodeignore`.

Always run `npm run compile` and `npm run lint` after touching `src/`.

## Conventions worth preserving

- No native binaries, no bundled parsers (Python or JS/TS), no vector DB / embeddings API — the
  whole point of this project is to stay dependency-light and work entirely with locally-available
  tooling (`python3`/`node` on PATH) plus one HTTP call to a user-configured chat-completions
  endpoint. When adding a language, prefer its stdlib test runner over anything requiring an
  install (this is *why* JS/TS uses `node:test` instead of Jest/Vitest).
- Settings live under the `contextLens.*` namespace in `package.json`'s `contributes.configuration`
  (`apiKey`, `apiBaseUrl`, `model`, `pythonPath`, `nodePath`, `maxRetries`, `temperature`,
  `maxOutputTokens`, `provider`). Read them via `vscode.workspace.getConfiguration("contextLens")`,
  not hardcoded values.
- `apiKey` falls back to the `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `GOOGLE_API_KEY` /
  `OPENAI_API_KEY` environment variables, in that order, when the setting is blank (see
  `resolveApiKey` in `llmClient.ts`).
- Keep modules importable/testable without a running VS Code instance where possible — check which
  files currently avoid importing `vscode` (listed above under Build & verify) before adding an
  import that would remove a module's unit-test coverage.
- Generated/verified tests are never written back into the user's source tree automatically; they're
  opened as an untitled document for the user to review and save themselves.
- Adding a new language means implementing one `LanguageAdapter` and registering it in
  `languages/registry.ts` — nothing else in the pipeline should need language-specific branches
  (if you find yourself adding an `if (adapter.id === "...")` outside a language adapter file,
  that's a sign the abstraction is leaking).
