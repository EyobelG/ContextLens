# AGENTS.md

## Project

ContextLens — a VS Code extension. It shows a CodeLens above Python functions that generates
`unittest` tests via an OpenAI-compatible LLM endpoint, the native Anthropic Messages API, or the
native Google Gemini API, verifies them by actually running `python3 -m unittest` in a sandboxed
temp directory, and retries (`contextLens.maxRetries`, default 3) on failure before surfacing the
tests to the user.

## Layout

| File | Role | Imports `vscode`? |
|---|---|---|
| `src/extension.ts` | Activation entry point; registers CodeLens provider + `contextLens.generateTest` command | yes |
| `src/codeLensProvider.ts` | Locates Python function defs, computes CodeLens ranges | yes |
| `src/astExtractor.ts` | Regex-based extraction of function name/params/return type/used imports | no |
| `src/ragEngine.ts` | Walks workspace `.py`/`.pyi` files, chunks per-function/class, scores/retrieves relevant context (biasable toward tests vs. source) | no |
| `src/testGenerator.ts` | Prompts the LLM, cleans response, drives the verify-and-retry loop | yes |
| `src/testRunner.ts` | Runs generated tests with `python3 -m unittest` in a temp dir | no |

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
npm test           # currently just runs `npm run compile`; no unit test suite exists yet
```

To exercise the extension itself: open this folder in VS Code and press F5 (or use the "Run Extension"
launch config in `.vscode/launch.json`), which runs `npm: watch` and opens an Extension Development
Host window. Open a `.py` file there to see the CodeLens.

## Before committing

Run, in order:

```bash
npm run compile
npm run lint
```

Both must pass with no errors. There is no CI config in this repo yet, so these are the only
automated gates — treat them as required.

## Conventions

- Keep `astExtractor.ts` and `ragEngine.ts` free of `vscode` imports so they stay testable outside the
  Extension Development Host.
- User-configurable behavior goes through `vscode.workspace.getConfiguration("contextLens")`
  (`apiKey`, `apiBaseUrl`, `model`, `pythonPath`, `maxRetries`), matching `contributes.configuration`
  in `package.json` — don't hardcode values that are already exposed as settings.
- `apiKey` falls back to `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `GOOGLE_API_KEY` / `OPENAI_API_KEY`
  env vars (in that order) when blank. Provider routing is inferred in `testGenerator.ts`: Anthropic
  via `isAnthropic()` (key prefix `sk-ant-` or `apiBaseUrl` containing `anthropic.com`), Gemini via
  `isGemini()` (key prefix `AIza` or `apiBaseUrl` containing `generativelanguage.googleapis.com`
  without `/openai`), else OpenAI-compatible chat-completions.
- No new runtime dependencies without a strong reason: this project deliberately avoids native
  binaries, bundled parsers, and vector DB/embeddings services.
