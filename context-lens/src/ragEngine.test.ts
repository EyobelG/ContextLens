import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { WorkspaceRagIndex } from "./ragEngine.js";

async function withTempWorkspace(files: Record<string, string>, run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "context-lens-rag-test-"));
  try {
    for (const [relativePath, content] of Object.entries(files)) {
      const fullPath = path.join(root, relativePath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content, "utf8");
    }
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

const deps = (functionName: string) => ({
  functionName, isMethod: false, isNested: false, paramTypes: {}, importedDependencies: [], rawCode: `def ${functionName}(): pass`
});

test("retrieves the file whose function name matches the query", async () => {
  await withTempWorkspace({
    "normalize.py": "def normalize_name(name):\n    return name.strip().lower()\n",
    "unrelated.py": "def totally_different_thing():\n    return 42\n"
  }, async (root) => {
    const index = new WorkspaceRagIndex();
    await index.buildWorkspaceIndex(root);
    const context = index.retrieveContext(deps("normalize_name"), "def normalize_name(name): pass");
    assert.match(context, /normalize_name/);
    assert.doesNotMatch(context, /totally_different_thing/);
  });
});

test("chunks a file per top-level function so unrelated functions in the same file don't drown out the match", async () => {
  const bigFile = `${"# padding line\n".repeat(50)}def target_fn(x):\n    return x * 2\n\ndef other_fn():\n    return "noise ".join(["word"] * 200)\n`;
  await withTempWorkspace({ "mixed.py": bigFile }, async (root) => {
    const index = new WorkspaceRagIndex();
    await index.buildWorkspaceIndex(root);
    const context = index.retrieveContext(deps("target_fn"), "def target_fn(x): pass", { limit: 1 });
    assert.match(context, /target_fn/);
    assert.doesNotMatch(context, /other_fn/);
  });
});

test("excludes files under ignored directories", async () => {
  await withTempWorkspace({
    "node_modules/pkg/setup.py": "def should_not_appear():\n    return True\n",
    ".venv/lib/thing.py": "def also_should_not_appear():\n    return True\n",
    "real.py": "def should_not_appear_locator():\n    return False\n"
  }, async (root) => {
    const index = new WorkspaceRagIndex();
    await index.buildWorkspaceIndex(root);
    const context = index.retrieveContext(deps("should_not_appear"), "def should_not_appear(): pass", { limit: 10 });
    assert.doesNotMatch(context, /node_modules/);
    assert.doesNotMatch(context, /\.venv/);
  });
});

test("preferTestArtifacts biases toward test/fixture files when term scores tie", async () => {
  // Same body text (so identical term-frequency score) in both files; the only difference is that
  // one filename classifies as "test". With the bias on, the test file should win the tiebreak.
  const body = "def widget_helper(x):\n    return x + 1\n";
  await withTempWorkspace({
    "widget_impl.py": body,
    "test_widget.py": body
  }, async (root) => {
    const index = new WorkspaceRagIndex();
    await index.buildWorkspaceIndex(root);
    const preferred = index.retrieveContext(deps("widget_helper"), "widget_helper", { limit: 1, preferTestArtifacts: true });
    assert.match(preferred, /# test: test_widget\.py/);
  });
});

test("retrieveContext returns empty string when nothing scores above zero", async () => {
  await withTempWorkspace({ "irrelevant.py": "def zzz_totally_unrelated_symbol_qqq():\n    pass\n" }, async (root) => {
    const index = new WorkspaceRagIndex();
    await index.buildWorkspaceIndex(root);
    const context = index.retrieveContext(deps("completely_different_name_here"), "no overlap at all with anything indexed");
    assert.equal(context, "");
  });
});
