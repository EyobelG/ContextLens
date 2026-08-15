import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DependencyMetadata } from "./astExtractor.js";

interface Chunk { file: string; symbol?: string; kind: "test" | "fixture" | "model" | "source"; content: string; }
interface RetrieveOptions { limit?: number; preferTestArtifacts?: boolean; }

const MAX_FILE_BYTES = 512_000;
const MAX_CHUNK_CHARS = 6_000;
const EXCLUDED = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build"]);
const TOP_LEVEL_SYMBOL = /^(?:async\s+)?def\s+([A-Za-z_]\w*)|^class\s+([A-Za-z_]\w*)/;

/** Lightweight local, persisted-free retrieval index. It avoids native binaries and API calls. */
export class WorkspaceRagIndex {
  private chunks: Chunk[] = [];

  async buildWorkspaceIndex(workspaceRoot: string): Promise<void> {
    this.chunks = [];
    await this.walk(workspaceRoot, workspaceRoot);
  }

  /**
   * `preferTestArtifacts` biases toward existing tests/fixtures (useful when writing new tests);
   * set it to false when looking for duplicate/reusable logic or convention consistency instead.
   */
  retrieveContext(dependencies: DependencyMetadata, querySnippet: string, options: RetrieveOptions = {}): string {
    const { limit = 5, preferTestArtifacts = true } = options;
    const terms = tokenize([dependencies.functionName, ...dependencies.importedDependencies, ...Object.values(dependencies.paramTypes), dependencies.returnType ?? "", querySnippet].join(" "));
    return this.chunks
      .map((chunk) => ({ chunk, score: score(chunk, terms, preferTestArtifacts) }))
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ chunk }) => `# ${chunk.kind}: ${chunk.file}${chunk.symbol ? ` :: ${chunk.symbol}` : ""}\n${chunk.content}`)
      .join("\n\n---\n\n");
  }

  private async walk(root: string, current: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) { if (!EXCLUDED.has(entry.name)) await this.walk(root, path.join(current, entry.name)); continue; }
      if (!entry.isFile() || !/\.(py|pyi)$/i.test(entry.name)) continue;
      const file = path.join(current, entry.name);
      try {
        const stat = await fs.stat(file);
        if (stat.size > MAX_FILE_BYTES) continue;
        const content = await fs.readFile(file, "utf8");
        const relativeFile = path.relative(root, file);
        const kind = classify(entry.name, content);
        for (const piece of splitIntoChunks(content)) {
          this.chunks.push({ file: relativeFile, symbol: piece.symbol, kind, content: piece.content });
        }
      } catch { /* unreadable files are intentionally skipped */ }
    }
  }
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

function classify(name: string, content: string): Chunk["kind"] {
  if (/^(test_|.*_test\.py$)/.test(name)) return "test";
  if (name === "conftest.py" || /@pytest\.fixture/.test(content)) return "fixture";
  if (/(class\s+\w+\s*\(|@dataclass|BaseModel|TypedDict)/.test(content)) return "model";
  return "source";
}
function trimChunk(content: string): string { return content.length > MAX_CHUNK_CHARS ? content.slice(0, MAX_CHUNK_CHARS) : content; }
function tokenize(value: string): Set<string> { return new Set(value.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? []); }

function score(chunk: Chunk, terms: Set<string>, preferTestArtifacts: boolean): number {
  const counts = tokenizeWithCounts(`${chunk.file} ${chunk.symbol ?? ""} ${chunk.content}`);
  let result = 0;
  for (const term of terms) {
    const count = counts.get(term) ?? 0;
    if (count === 0) continue;
    result += (term.length > 3 ? 2 : 1) * Math.min(count, 4);
  }
  if (result === 0) return 0;
  if (chunk.symbol && terms.has(chunk.symbol.toLowerCase())) result += 5;
  if (preferTestArtifacts && (chunk.kind === "test" || chunk.kind === "fixture")) result += 1;
  return result;
}

function tokenizeWithCounts(value: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of value.toLowerCase().matchAll(/[a-z_][a-z0-9_]*/g)) {
    counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
  }
  return counts;
}
