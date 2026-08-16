import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ChunkKind, DependencyMetadata, LanguageAdapter } from "./languages/types.js";

interface Chunk { file: string; symbol?: string; kind: ChunkKind; content: string; }
interface RetrieveOptions { limit?: number; preferTestArtifacts?: boolean; }

const MAX_FILE_BYTES = 512_000;
const EXCLUDED = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build"]);

/** Lightweight local, persisted-free retrieval index. It avoids native binaries and API calls. */
export class WorkspaceRagIndex {
  private chunks: Chunk[] = [];

  constructor(private readonly adapter: LanguageAdapter) {}

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
    const terms = tokenize(
      [dependencies.functionName, ...dependencies.importedDependencies, ...Object.values(dependencies.paramTypes), dependencies.returnType ?? "", querySnippet].join(" "),
      this.adapter.stopwords
    );
    return this.chunks
      .map((chunk) => ({ chunk, score: score(chunk, terms, preferTestArtifacts, this.adapter.stopwords) }))
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
      if (!entry.isFile() || !this.adapter.fileExtensionPattern.test(entry.name)) continue;
      const file = path.join(current, entry.name);
      try {
        const stat = await fs.stat(file);
        if (stat.size > MAX_FILE_BYTES) continue;
        const content = await fs.readFile(file, "utf8");
        const relativeFile = path.relative(root, file);
        const kind = this.adapter.classifyFile(entry.name, content);
        for (const piece of this.adapter.splitIntoChunks(content)) {
          this.chunks.push({ file: relativeFile, symbol: piece.symbol, kind, content: piece.content });
        }
      } catch { /* unreadable files are intentionally skipped */ }
    }
  }
}

function tokenize(value: string, stopwords: Set<string>): Set<string> {
  const tokens = value.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? [];
  return new Set(tokens.filter((token) => !stopwords.has(token)));
}

function score(chunk: Chunk, terms: Set<string>, preferTestArtifacts: boolean, stopwords: Set<string>): number {
  const counts = tokenizeWithCounts(`${chunk.file} ${chunk.symbol ?? ""} ${chunk.content}`, stopwords);
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

function tokenizeWithCounts(value: string, stopwords: Set<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of value.toLowerCase().matchAll(/[a-z_][a-z0-9_]*/g)) {
    if (stopwords.has(match[0])) continue;
    counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
  }
  return counts;
}
