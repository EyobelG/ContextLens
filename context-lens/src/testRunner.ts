import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export interface TestRunResult { passed: boolean; output: string; durationMs: number; }

export async function runPythonTests(sourceCode: string, testCode: string, pythonPath: string): Promise<TestRunResult> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "context-lens-"));
  const testFile = path.join(directory, "test_generated.py");
  const started = Date.now();
  try {
    await fs.writeFile(testFile, `${sourceCode}\n\n${testCode}\n`, "utf8");
    const { stdout, stderr } = await execFileAsync(pythonPath, ["-m", "unittest", "-v", testFile], {
      timeout: 10_000, windowsHide: true, maxBuffer: 1_000_000
    });
    return { passed: true, output: [stdout, stderr].filter(Boolean).join("\n"), durationMs: Date.now() - started };
  } catch (error: unknown) {
    const details = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean };
    const output = [details.stderr, details.stdout, details.killed ? "Test execution timed out after 10 seconds." : "", details.message]
      .filter(Boolean).join("\n");
    return { passed: false, output, durationMs: Date.now() - started };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
