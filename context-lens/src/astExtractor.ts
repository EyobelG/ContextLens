export interface DependencyMetadata {
  functionName: string;
  className?: string;
  isMethod: boolean;
  /** True when this is a `def` nested inside another `def` (not a class) — not independently callable. */
  isNested: boolean;
  paramTypes: Record<string, string | undefined>;
  returnType?: string;
  importedDependencies: string[];
  rawCode: string;
}

const DEF_PATTERN = /^([ \t]*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?:->\s*([^:]+))?:/gm;
const CLASS_LINE = /^[ \t]*class\s+([A-Za-z_]\w*)/;

/**
 * Extracts useful Python symbols without requiring a Python parser at extension runtime.
 *
 * `sourceSlice` may be a single function's text or a whole class's text (when the target is a
 * method, the CodeLens provider sends the enclosing class so `self` references resolve when the
 * sandbox runs it). `focusSymbol`, when given, picks which `def` inside `sourceSlice` to extract
 * metadata for; when omitted, the first `def` found is used (preserves plain-selection behavior).
 */
export function extractPythonDependencies(documentText: string, sourceSlice: string, focusSymbol?: string): DependencyMetadata {
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
