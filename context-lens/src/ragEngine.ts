import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DependencyMetadata } from "./astExtractor.js";

interface Chunk { file: string; kind: "test" | "fixture" | "model" | "source"; content: string; }
const MAX_FILE_BYTES = 512_000;
const EXCLUDED = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build"]);

/** Lightweight local, persisted-free retrieval index. It avoids native binaries and API calls. */
export class WorkspaceRagIndex {
  private chunks: Chunk[] = [];

  async buildWorkspaceIndex(workspaceRoot: string): Promise<void> {
    this.chunks = [];
    await this.walk(workspaceRoot, workspaceRoot);
  }

  retrieveContext(dependencies: DependencyMetadata, querySnippet: string, limit = 5): string {
    const terms = tokenize([dependencies.functionName, ...dependencies.importedDependencies, ...Object.values(dependencies.paramTypes), dependencies.returnType ?? "", querySnippet].join(" "));
    return this.chunks
      .map((chunk) => ({ chunk, score: score(chunk, terms) }))
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ chunk }) => `# ${chunk.kind}: ${chunk.file}\n${chunk.content}`)
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
        this.chunks.push({ file: path.relative(root, file), kind: classify(entry.name, content), content: trimChunk(content) });
      } catch { /* unreadable files are intentionally skipped */ }
    }
  }
}

function classify(name: string, content: string): Chunk["kind"] {
  if (/^(test_|.*_test\.py$)/.test(name)) return "test";
  if (name === "conftest.py" || /@pytest\.fixture/.test(content)) return "fixture";
  if (/(class\s+\w+\s*\(|@dataclass|BaseModel|TypedDict)/.test(content)) return "model";
  return "source";
}
function trimChunk(content: string): string { return content.length > 12_000 ? content.slice(0, 12_000) : content; }
function tokenize(value: string): Set<string> { return new Set(value.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? []); }
function score(chunk: Chunk, terms: Set<string>): number {
  const words = tokenize(`${chunk.file} ${chunk.content}`); let result = 0;
  for (const term of terms) if (words.has(term)) result += term.length > 3 ? 2 : 1;
  return result + (chunk.kind === "test" || chunk.kind === "fixture" ? 1 : 0);
}
