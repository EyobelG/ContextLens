import { CodeLensTarget, DependencyMetadata, LanguageAdapter } from "./types.js";

const DEF_PATTERN = /^([ \t]*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?:->\s*([^:]+))?:/gm;
const SIMPLE_DEF_LINE = /^[ \t]*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/;
const CLASS_LINE = /^[ \t]*class\s+([A-Za-z_]\w*)/;
const CLASS_PATTERN = /^[ \t]*class\s+/;
const TOP_LEVEL_SYMBOL = /^(?:async\s+)?def\s+([A-Za-z_]\w*)|^class\s+([A-Za-z_]\w*)/;
const MAX_CHUNK_CHARS = 6_000;

/**
 * Extracts useful Python symbols without requiring a Python parser at extension runtime.
 *
 * `sourceSlice` may be a single function's text or a whole class's text (when the target is a
 * method, the CodeLens provider sends the enclosing class so `self` references resolve when the
 * sandbox runs it). `focusSymbol`, when given, picks which `def` inside `sourceSlice` to extract
 * metadata for; when omitted, the first `def` found is used (preserves plain-selection behavior).
 */
function extractDependencies(documentText: string, sourceSlice: string, focusSymbol?: string): DependencyMetadata {
  let target: RegExpMatchArray | undefined;
  for (const match of sourceSlice.matchAll(DEF_PATTERN)) {
    if (focusSymbol && match[2] !== focusSymbol) continue;
    target = match;
    break;
  }
  if (!target) {
    throw new Error(focusSymbol
      ? `Could not find a function or method named "${focusSymbol}" in the selected code.`
      : "The selected code is not a complete Python function definition.");
  }

  const [, indent, functionName, paramList, returnType] = target;
  const defIndex = target.index ?? 0;
  const lines = sourceSlice.split("\n");
  const defLineIndex = countNewlines(sourceSlice, defIndex);
  // The signature itself may span multiple lines; the body can't start until after its closing
  // line, so scan for the block end starting there rather than right after the `def` line.
  const signatureEndLine = countNewlines(sourceSlice, defIndex + target[0].length);
  const bodyEndLine = findBlockEnd(lines, signatureEndLine, indent.length);
  const rawCode = lines.slice(defLineIndex, bodyEndLine).join("\n").trim();

  const paramTypes: Record<string, string | undefined> = {};
  for (const parameter of splitTopLevel(paramList, ",").map((part) => part.trim()).filter(Boolean)) {
    const match = parameter.match(/^([A-Za-z_]\w*)\s*(?::\s*([^=]+?))?(?:\s*=.*)?$/s);
    if (match) paramTypes[match[1]] = match[2]?.trim();
  }

  const { className, isMethod } = findEnclosingClass(documentText, sourceSlice, defIndex, indent.length);
  const isNested = indent.length > 0 && !isMethod;

  const imports = collectImports(documentText);
  const used = [...imports].filter(([name]) => new RegExp(`\\b${escapeRegExp(name)}\\b`).test(rawCode));

  return {
    functionName, className, isMethod, isNested, paramTypes,
    returnType: returnType?.trim(),
    importedDependencies: used.map(([, source]) => source),
    rawCode
  };
}

/** Splits on `separator` only at bracket depth 0, so `List[int, str]` or `f(a, b)` isn't split apart. */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    if (char === separator && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

function countNewlines(text: string, upTo: number): number {
  let count = 0;
  for (let i = 0; i < upTo; i += 1) if (text[i] === "\n") count += 1;
  return count;
}

function findBlockEnd(lines: string[], start: number, indent: number): number {
  let line = start + 1;
  while (line < lines.length) {
    const text = lines[line];
    const trimmed = text.trim();
    if (trimmed) {
      const lineIndent = text.length - text.trimStart().length;
      if (lineIndent <= indent) break;
    }
    line += 1;
  }
  return line;
}

/** Walks backward from the def's position in the full document to find its nearest enclosing `class`. */
function findEnclosingClass(documentText: string, sourceSlice: string, defIndexInSlice: number, defIndent: number): { className?: string; isMethod: boolean } {
  if (defIndent === 0) return { isMethod: false };
  const sliceOffset = documentText.indexOf(sourceSlice);
  if (sliceOffset === -1) return { isMethod: false };
  const absoluteDefIndex = sliceOffset + defIndexInSlice;
  const beforeLines = documentText.slice(0, absoluteDefIndex).split("\n");
  for (let i = beforeLines.length - 1; i >= 0; i -= 1) {
    const text = beforeLines[i];
    const trimmed = text.trim();
    if (!trimmed) continue;
    const lineIndent = text.length - text.trimStart().length;
    if (lineIndent >= defIndent) continue;
    const match = text.match(CLASS_LINE);
    return match ? { className: match[1], isMethod: true } : { isMethod: false };
  }
  return { isMethod: false };
}

function collectImports(documentText: string): Map<string, string> {
  const imports = new Map<string, string>();
  const importPattern = /^(?:from\s+([\w.]+)\s+import\s+(.+)|import\s+(.+))$/gm;
  for (const match of documentText.matchAll(importPattern)) {
    if (match[1]) {
      for (const item of match[2].split(",")) {
        const [symbol, alias] = item.trim().split(/\s+as\s+/);
        imports.set(alias ?? symbol, `${match[1]}.${symbol}`);
      }
    } else {
      for (const item of match[3].split(",")) {
        const [module, alias] = item.trim().split(/\s+as\s+/);
        imports.set(alias ?? module.split(".")[0], module);
      }
    }
  }
  return imports;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findCodeLensTargets(documentText: string): CodeLensTarget[] {
  const lines = documentText.split("\n");
  const targets: CodeLensTarget[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(SIMPLE_DEF_LINE);
    if (!match) continue;
    const indent = lines[i].length - lines[i].trimStart().length;
    const symbolName = match[1];
    if (indent === 0) {
      const end = findBlockEnd(lines, i, indent);
      targets.push({ line: i, containerStartLine: i, containerEndLine: end, symbolName });
      continue;
    }
    const container = findOuterContainerLines(lines, i, indent);
    const end = findBlockEnd(lines, container.line, container.indent);
    targets.push({ line: i, containerStartLine: container.line, containerEndLine: end, symbolName });
  }
  return targets;
}

/**
 * Climbs from an indented `def` up through its ancestors. Stops as soon as it reaches a `class`
 * line (that's the natural container for a method) or indentation 0 (a plain nested function's
 * outermost enclosing function), whichever comes first.
 */
function findOuterContainerLines(lines: string[], line: number, indent: number): { line: number; indent: number } {
  let currentLine = line;
  let currentIndent = indent;
  while (currentIndent > 0) {
    const ancestor = findNearestLowerIndentLine(lines, currentLine, currentIndent);
    if (ancestor === undefined) break;
    currentLine = ancestor;
    currentIndent = lines[ancestor].length - lines[ancestor].trimStart().length;
    if (CLASS_PATTERN.test(lines[ancestor])) break;
  }
  return { line: currentLine, indent: currentIndent };
}

function findNearestLowerIndentLine(lines: string[], fromLine: number, belowIndent: number): number | undefined {
  for (let line = fromLine - 1; line >= 0; line -= 1) {
    if (!lines[line].trim()) continue;
    const indent = lines[line].length - lines[line].trimStart().length;
    if (indent >= belowIndent) continue;
    return line;
  }
  return undefined;
}

/** Splits a file into per-function/class chunks (falling back to the whole file) for finer-grained retrieval. */
function splitIntoChunks(content: string): Array<{ symbol?: string; content: string }> {
  const lines = content.split("\n");
  const boundaries: Array<{ start: number; symbol: string }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!/^\S/.test(line)) continue;
    const match = line.match(TOP_LEVEL_SYMBOL);
    if (match) boundaries.push({ start: i, symbol: match[1] ?? match[2] });
  }
  if (boundaries.length === 0) return [{ content: trimChunk(content) }];

  const chunks: Array<{ symbol?: string; content: string }> = [];
  if (boundaries[0].start > 0) {
    const preamble = lines.slice(0, boundaries[0].start).join("\n").trim();
    if (preamble) chunks.push({ symbol: "(module-level)", content: trimChunk(preamble) });
  }
  for (let i = 0; i < boundaries.length; i += 1) {
    const end = i + 1 < boundaries.length ? boundaries[i + 1].start : lines.length;
    const text = lines.slice(boundaries[i].start, end).join("\n").trim();
    if (text) chunks.push({ symbol: boundaries[i].symbol, content: trimChunk(text) });
  }
  return chunks;
}

function trimChunk(content: string): string { return content.length > MAX_CHUNK_CHARS ? content.slice(0, MAX_CHUNK_CHARS) : content; }

function classifyFile(name: string, content: string): "test" | "fixture" | "model" | "source" {
  if (/^(test_|.*_test\.py$)/.test(name)) return "test";
  if (name === "conftest.py" || /@pytest\.fixture/.test(content)) return "fixture";
  if (/(class\s+\w+\s*\(|@dataclass|BaseModel|TypedDict)/.test(content)) return "model";
  return "source";
}

const STOPWORDS = new Set([
  "def", "class", "return", "self", "cls", "import", "from", "as", "if", "elif", "else", "for",
  "while", "try", "except", "finally", "with", "pass", "break", "continue", "lambda", "yield",
  "raise", "assert", "true", "false", "none", "and", "or", "not", "in", "is", "async", "await",
  "global", "nonlocal", "del", "py", "pyi"
]);

export const pythonAdapter: LanguageAdapter = {
  id: "python",
  vscodeLanguageIds: ["python"],
  displayName: "Python",
  frameworkName: "unittest",
  fileExtensionPattern: /\.(py|pyi)$/i,
  testFileNamePattern: /^(test_|.*_test\.py$)/,
  runnableFileExtension: ".py",
  codeFencePattern: /```(?:python)?\s*([\s\S]*?)```/i,
  lineCommentPrefix: "#",
  stopwords: STOPWORDS,
  runnerSettingKey: "pythonPath",
  defaultRunnerPath: "python3",
  findCodeLensTargets,
  extractDependencies,
  splitIntoChunks,
  classifyFile,
  buildRunnableSource: (sourceCode, testCode) => `${sourceCode}\n\n${testCode}\n`,
  runArgs: (testFilePath) => ["-m", "unittest", "-v", testFilePath]
};
