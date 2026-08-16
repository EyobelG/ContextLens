import { CodeLensTarget, DependencyMetadata, LanguageAdapter } from "./types.js";

const MAX_CHUNK_CHARS = 6_000;

/**
 * Replaces the contents of string/template literals and comments with spaces (preserving length
 * and line breaks), so brace/keyword scanning never gets confused by braces or keywords that
 * happen to appear inside a string or a comment. This is deliberately not a real JS parser —
 * template-literal `${...}` interpolations are masked opaquely rather than re-entering code mode,
 * which is the main known gap (functions defined inside an interpolation won't be detected).
 */
function maskNonCode(text: string): string {
  const out = text.split("");
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") { out[i] = " "; i += 1; }
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      out[i] = " "; out[i + 1] = " "; i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] !== "\n") out[i] = " ";
        i += 1;
      }
      if (i < n) { out[i] = " "; out[i + 1] = " "; i += 2; }
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      out[i] = " "; i += 1;
      while (i < n && text[i] !== quote && text[i] !== "\n") {
        if (text[i] === "\\") { out[i] = " "; i += 1; if (i < n) { out[i] = " "; i += 1; } continue; }
        out[i] = " "; i += 1;
      }
      if (i < n && text[i] === quote) { out[i] = " "; i += 1; }
      continue;
    }
    if (c === "`") {
      out[i] = " "; i += 1;
      while (i < n && text[i] !== "`") {
        if (text[i] === "\\") { out[i] = " "; i += 1; if (i < n) { if (text[i] !== "\n") out[i] = " "; i += 1; } continue; }
        if (text[i] !== "\n") out[i] = " ";
        i += 1;
      }
      if (i < n) { out[i] = " "; i += 1; }
      continue;
    }
    i += 1;
  }
  return out.join("");
}

function findMatchingBrace(masked: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < masked.length; i += 1) {
    if (masked[i] === "{") depth += 1;
    else if (masked[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return masked.length - 1;
}

interface RawDef { name: string; declStart: number; braceOpen: number; braceClose: number; }
interface RawClass { name: string; declStart: number; bodyStart: number; bodyEnd: number; }

const FUNCTION_DECL = /\bfunction\s*\*?\s+([A-Za-z_$][\w$]*)\s*\(/g;
const ARROW_ASSIGN = /\b([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/g;
const CLASS_DECL = /\bclass\s+([A-Za-z_$][\w$]*)/g;
const MEMBER_DECL = /^[ \t\n]*(?:static\s+|async\s+|\*\s*|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*\(([^()]*)\)\s*(?::\s*[^{=]+)?\{/;

function findClasses(masked: string): RawClass[] {
  const classes: RawClass[] = [];
  for (const match of masked.matchAll(CLASS_DECL)) {
    const declStart = match.index ?? 0;
    const braceOpen = masked.indexOf("{", declStart + match[0].length);
    if (braceOpen === -1) continue;
    const braceClose = findMatchingBrace(masked, braceOpen);
    classes.push({ name: match[1], declStart, bodyStart: braceOpen + 1, bodyEnd: braceClose });
  }
  return classes;
}

function findClassMembers(masked: string, bodyStart: number, bodyEnd: number): RawDef[] {
  const members: RawDef[] = [];
  let i = bodyStart;
  while (i < bodyEnd) {
    const ch = masked[i];
    if (/\s/.test(ch) || ch === ";") { i += 1; continue; }
    const slice = masked.slice(i, bodyEnd);
    const match = slice.match(MEMBER_DECL);
    if (match) {
      const braceOpen = i + match[0].length - 1;
      const braceClose = findMatchingBrace(masked, braceOpen);
      members.push({ name: match[1], declStart: i, braceOpen, braceClose });
      i = braceClose + 1;
      continue;
    }
    if (ch === "{") { i = findMatchingBrace(masked, i) + 1; continue; }
    i += 1;
  }
  return members;
}

function findFunctionsAndArrows(masked: string): RawDef[] {
  const defs: RawDef[] = [];
  for (const match of masked.matchAll(FUNCTION_DECL)) {
    const declStart = match.index ?? 0;
    const braceOpen = masked.indexOf("{", declStart + match[0].length);
    if (braceOpen === -1) continue;
    defs.push({ name: match[1], declStart, braceOpen, braceClose: findMatchingBrace(masked, braceOpen) });
  }
  for (const match of masked.matchAll(ARROW_ASSIGN)) {
    const declStart = match.index ?? 0;
    const braceOpen = declStart + match[0].length - 1;
    defs.push({ name: match[1], declStart, braceOpen, braceClose: findMatchingBrace(masked, braceOpen) });
  }
  return defs;
}

function collectAllDefinitions(sourceText: string): { classes: RawClass[]; defs: RawDef[] } {
  const masked = maskNonCode(sourceText);
  const classes = findClasses(masked);
  const defs = findFunctionsAndArrows(masked);
  for (const cls of classes) defs.push(...findClassMembers(masked, cls.bodyStart, cls.bodyEnd));
  return { classes, defs };
}

interface Resolved {
  name: string; declStart: number; braceOpen: number; braceClose: number;
  className?: string; isMethod: boolean; isNested: boolean;
  containerDeclStart: number; containerBraceClose: number;
}

function resolveContainers(classes: RawClass[], defs: RawDef[]): Resolved[] {
  return defs.map((def) => {
    let enclosingClass: RawClass | undefined;
    for (const cls of classes) {
      if (def.declStart > cls.bodyStart - 1 && def.declStart < cls.bodyEnd) {
        if (!enclosingClass || (cls.bodyEnd - cls.bodyStart) < (enclosingClass.bodyEnd - enclosingClass.bodyStart)) enclosingClass = cls;
      }
    }
    if (enclosingClass) {
      return {
        name: def.name, declStart: def.declStart, braceOpen: def.braceOpen, braceClose: def.braceClose,
        className: enclosingClass.name, isMethod: true, isNested: false,
        containerDeclStart: enclosingClass.declStart, containerBraceClose: enclosingClass.bodyEnd
      };
    }
    let enclosingDef: RawDef | undefined;
    for (const other of defs) {
      if (other === def) continue;
      if (def.declStart > other.braceOpen && def.declStart < other.braceClose) {
        if (!enclosingDef || (other.braceClose - other.braceOpen) < (enclosingDef.braceClose - enclosingDef.braceOpen)) enclosingDef = other;
      }
    }
    if (enclosingDef) {
      return {
        name: def.name, declStart: def.declStart, braceOpen: def.braceOpen, braceClose: def.braceClose,
        isMethod: false, isNested: true,
        containerDeclStart: enclosingDef.declStart, containerBraceClose: enclosingDef.braceClose
      };
    }
    return {
      name: def.name, declStart: def.declStart, braceOpen: def.braceOpen, braceClose: def.braceClose,
      isMethod: false, isNested: false,
      containerDeclStart: def.declStart, containerBraceClose: def.braceClose
    };
  });
}

function countNewlines(text: string, upTo: number): number {
  let count = 0;
  for (let i = 0; i < upTo && i < text.length; i += 1) if (text[i] === "\n") count += 1;
  return count;
}

function findCodeLensTargets(documentText: string): CodeLensTarget[] {
  const { classes, defs } = collectAllDefinitions(documentText);
  return resolveContainers(classes, defs).map((r) => ({
    line: countNewlines(documentText, r.declStart),
    containerStartLine: countNewlines(documentText, r.containerDeclStart),
    containerEndLine: countNewlines(documentText, r.containerBraceClose) + 1,
    symbolName: r.name
  }));
}

/** Splits on `,` only at bracket/paren depth 0, so `{ a, b }` or `(x, y) => x` param defaults aren't split apart. */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    if (char === separator && depth === 0) { parts.push(current); current = ""; } else { current += char; }
  }
  parts.push(current);
  return parts;
}

function extractParams(declText: string): Record<string, string | undefined> {
  const paramMatch = declText.match(/\(([^()]*)\)/);
  const paramList = paramMatch ? paramMatch[1] : "";
  const paramTypes: Record<string, string | undefined> = {};
  for (const raw of splitTopLevel(paramList, ",").map((p) => p.trim()).filter(Boolean)) {
    const match = raw.match(/^([A-Za-z_$][\w$]*)\s*\??\s*(?::\s*([^=]+?))?(?:\s*=.*)?$/s);
    if (match) paramTypes[match[1]] = match[2]?.trim();
    else paramTypes[raw] = undefined; // destructured/rest params: keep raw text as the "name" best-effort
  }
  return paramTypes;
}

function collectImportedNames(documentText: string): string[] {
  const names = new Set<string>();
  for (const match of documentText.matchAll(/import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{([^}]*)\})?\s+from/g)) {
    if (match[1]) names.add(match[1]);
    if (match[2]) for (const item of match[2].split(",")) { const n = item.trim().split(/\s+as\s+/).pop(); if (n) names.add(n); }
  }
  for (const match of documentText.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
    for (const item of match[1].split(",")) { const n = item.trim().split(/\s+as\s+/).pop(); if (n) names.add(n); }
  }
  for (const match of documentText.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(/g)) names.add(match[1]);
  return [...names];
}

function extractDependencies(documentText: string, sourceSlice: string, focusSymbol?: string): DependencyMetadata {
  const { classes, defs } = collectAllDefinitions(sourceSlice);
  const target = focusSymbol ? defs.find((d) => d.name === focusSymbol) : defs[0];
  if (!target) {
    throw new Error(focusSymbol
      ? `Could not find a function or method named "${focusSymbol}" in the selected code.`
      : "The selected code is not a complete JavaScript/TypeScript function definition.");
  }
  const resolved = resolveContainers(classes, defs).find((r) => r.declStart === target.declStart && r.name === target.name);
  if (!resolved) throw new Error(`Could not resolve metadata for "${target.name}".`);

  const rawCode = sourceSlice.slice(target.declStart, target.braceClose + 1).trim();
  const declText = sourceSlice.slice(target.declStart, target.braceOpen + 1);
  const paramTypes = extractParams(declText);
  const returnMatch = declText.match(/\)\s*:\s*([^{]+)\{$/);
  const returnType = returnMatch ? returnMatch[1].trim() : undefined;

  const imported = collectImportedNames(documentText).filter((name) => new RegExp(`\\b${escapeRegExp(name)}\\b`).test(rawCode));

  return {
    functionName: target.name,
    className: resolved.className,
    isMethod: resolved.isMethod,
    isNested: resolved.isNested,
    paramTypes,
    returnType,
    importedDependencies: imported,
    rawCode
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function splitIntoChunks(content: string): Array<{ symbol?: string; content: string }> {
  const { classes, defs } = collectAllDefinitions(content);
  const topLevel = resolveContainers(classes, defs).filter((r) => !r.isMethod && !r.isNested);
  const classBoundaries = classes.map((c) => ({ start: c.declStart, end: c.bodyEnd + 1, symbol: c.name }));
  const funcBoundaries = topLevel
    .filter((r) => !classBoundaries.some((c) => r.declStart >= c.start && r.declStart < c.end))
    .map((r) => ({ start: r.declStart, end: r.braceClose + 1, symbol: r.name }));
  const boundaries = [...classBoundaries, ...funcBoundaries].sort((a, b) => a.start - b.start);
  if (boundaries.length === 0) return [{ content: trimChunk(content) }];

  const chunks: Array<{ symbol?: string; content: string }> = [];
  if (boundaries[0].start > 0) {
    const preamble = content.slice(0, boundaries[0].start).trim();
    if (preamble) chunks.push({ symbol: "(module-level)", content: trimChunk(preamble) });
  }
  for (let i = 0; i < boundaries.length; i += 1) {
    const end = i + 1 < boundaries.length ? boundaries[i + 1].start : content.length;
    const text = content.slice(boundaries[i].start, end).trim();
    if (text) chunks.push({ symbol: boundaries[i].symbol, content: trimChunk(text) });
  }
  return chunks;
}

function trimChunk(content: string): string { return content.length > MAX_CHUNK_CHARS ? content.slice(0, MAX_CHUNK_CHARS) : content; }

function classifyFile(name: string, content: string): "test" | "fixture" | "model" | "source" {
  if (/\.(test|spec)\.[jt]sx?$/.test(name) || /^__tests__$/.test(name)) return "test";
  if (/^(setup|jest\.setup|vitest\.setup)/.test(name)) return "fixture";
  if (/\binterface\s+\w+|:\s*z\.object\(|extends\s+Model\b/.test(content)) return "model";
  return "source";
}

const STOPWORDS = new Set([
  "function", "return", "class", "const", "let", "var", "import", "export", "from", "default",
  "if", "else", "for", "while", "do", "switch", "case", "break", "continue", "try", "catch",
  "finally", "throw", "new", "this", "super", "extends", "implements", "static", "async", "await",
  "yield", "typeof", "instanceof", "in", "of", "true", "false", "null", "undefined", "void",
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "public", "private", "protected", "readonly", "interface",
  "type", "get", "set"
]);

/**
 * Both the JavaScript and TypeScript adapters share every code-structure heuristic above (JS's
 * syntax is a strict subset of TS's for the purposes of this regex-based scanner); they differ
 * only in which file extensions/vscode languages they cover and how the sandbox runs the result —
 * `.mjs` needs no flags, `.ts` needs Node's (22.6+, flagged; 23.6+, unflagged) type-stripping.
 */
function createAdapter(options: {
  id: string; vscodeLanguageIds: string[]; displayName: string; fileExtensionPattern: RegExp;
  runnableFileExtension: string; runArgs: (testFilePath: string) => string[];
}): LanguageAdapter {
  return {
    id: options.id,
    vscodeLanguageIds: options.vscodeLanguageIds,
    displayName: options.displayName,
    frameworkName: "node:test",
    fileExtensionPattern: options.fileExtensionPattern,
    testFileNamePattern: /\.(test|spec)\.[jt]sx?$/,
    runnableFileExtension: options.runnableFileExtension,
    codeFencePattern: /```(?:javascript|typescript|jsx|tsx|js|ts)?\s*([\s\S]*?)```/i,
    lineCommentPrefix: "//",
    stopwords: STOPWORDS,
    runnerSettingKey: "nodePath",
    defaultRunnerPath: "node",
    findCodeLensTargets,
    extractDependencies,
    splitIntoChunks,
    classifyFile,
    buildRunnableSource: (sourceCode, testCode) => `${sourceCode}\n\n${testCode}\n`,
    runArgs: options.runArgs
  };
}

export const javascriptAdapter = createAdapter({
  id: "javascript",
  vscodeLanguageIds: ["javascript", "javascriptreact"],
  displayName: "JavaScript",
  fileExtensionPattern: /\.(js|jsx|mjs|cjs)$/i,
  runnableFileExtension: ".mjs",
  runArgs: (testFilePath) => ["--test", testFilePath]
});

export const typescriptAdapter = createAdapter({
  id: "typescript",
  vscodeLanguageIds: ["typescript", "typescriptreact"],
  displayName: "TypeScript",
  fileExtensionPattern: /\.(ts|tsx)$/i,
  runnableFileExtension: ".ts",
  runArgs: (testFilePath) => ["--experimental-strip-types", "--test", testFilePath]
});
