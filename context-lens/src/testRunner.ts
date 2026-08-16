import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { LanguageAdapter } from "./languages/types.js";

export interface TestRunResult { passed: boolean; output: string; durationMs: number; }

/** Minimal shape of vscode.CancellationToken — avoids importing `vscode` into this module. */
export interface CancellationSignal {
  isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

export class TestRunCancelledError extends Error {
  constructor() { super("Cancelled by user."); this.name = "TestRunCancelledError"; }
}

export async function runTests(sourceCode: string, testCode: string, adapter: LanguageAdapter, runnerPath: string, cancellation?: CancellationSignal): Promise<TestRunResult> {
  if (cancellation?.isCancellationRequested) throw new TestRunCancelledError();

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "context-lens-"));
  const testFile = path.join(directory, `test_generated${adapter.runnableFileExtension}`);
  const started = Date.now();
  try {
    await fs.writeFile(testFile, adapter.buildRunnableSource(sourceCode, testCode), "utf8");
    return await new Promise<TestRunResult>((resolve, reject) => {
      const child = execFile(runnerPath, adapter.runArgs(testFile), {
        timeout: 10_000, windowsHide: true, maxBuffer: 1_000_000
      }, (error, stdout, stderr) => {
        subscription?.dispose();
        if (!error) {
          resolve({ passed: true, output: [stdout, stderr].filter(Boolean).join("\n"), durationMs: Date.now() - started });
          return;
        }
        const details = error as NodeJS.ErrnoException & { killed?: boolean };
        if (cancellation?.isCancellationRequested) { reject(new TestRunCancelledError()); return; }
        const output = [stderr, stdout, details.killed ? "Test execution timed out after 10 seconds." : "", details.message]
          .filter(Boolean).join("\n");
        resolve({ passed: false, output, durationMs: Date.now() - started });
      });
      const subscription = cancellation?.onCancellationRequested(() => child.kill());
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
