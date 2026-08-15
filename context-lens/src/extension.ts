import * as vscode from "vscode";
import { extractPythonDependencies } from "./astExtractor.js";
import { FunctionTestCodeLensProvider } from "./codeLensProvider.js";
import { WorkspaceRagIndex } from "./ragEngine.js";
import { synthesizeVerifiedTests } from "./testGenerator.js";

const ragIndexes = new Map<string, WorkspaceRagIndex>();

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("ContextLens");

  context.subscriptions.push(
    output,
    vscode.languages.registerCodeLensProvider({ language: "python" }, new FunctionTestCodeLensProvider()),
    vscode.commands.registerCommand("contextLens.generateTest", (rawCodeArg?: string) =>
      generateTest(rawCodeArg, output)
    )
  );
}

export function deactivate(): void {
  ragIndexes.clear();
}

async function generateTest(rawCodeArg: string | undefined, output: vscode.OutputChannel): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "python") {
    vscode.window.showErrorMessage("ContextLens: open a Python file first.");
    return;
  }

  const rawCode = rawCodeArg ?? editor.document.getText(editor.selection);
  if (!rawCode.trim()) {
    vscode.window.showErrorMessage("ContextLens: select a function, or use the CodeLens action above a function definition.");
    return;
  }

  try {
    const dependencies = extractPythonDependencies(editor.document.getText(), rawCode);

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "ContextLens", cancellable: false },
      async (progress) => {
        const index = await getWorkspaceIndex(editor.document.uri, (message) => {
          output.appendLine(message);
          progress.report({ message });
        });

        const result = await synthesizeVerifiedTests(rawCode, dependencies, index, (message) => {
          output.appendLine(message);
          progress.report({ message });
        });

        const analysisComment = result.analysis
          ? `# ContextLens analysis of "${dependencies.functionName}":\n${result.analysis.split("\n").map((line) => `# ${line}`).join("\n")}\n\n`
          : "";
        const document = await vscode.workspace.openTextDocument({ language: "python", content: `${analysisComment}${result.tests}` });
        await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside });

        if (result.analysis) {
          output.appendLine(`\nAnalysis of "${dependencies.functionName}":\n${result.analysis}`);
        }
        vscode.window.showInformationMessage(
          `ContextLens: verified tests generated for "${dependencies.functionName}" (${result.attempts} attempt${result.attempts === 1 ? "" : "s"}).`
        );
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`Error: ${message}`);
    output.show(true);
    vscode.window.showErrorMessage(`ContextLens: ${message}`);
  }
}

async function getWorkspaceIndex(documentUri: vscode.Uri, report: (message: string) => void): Promise<WorkspaceRagIndex> {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri) ?? vscode.workspace.workspaceFolders?.[0];
  const root = workspaceFolder?.uri.fsPath ?? "";
  const cached = ragIndexes.get(root);
  if (cached) return cached;

  report("Indexing workspace for context...");
  const index = new WorkspaceRagIndex();
  await index.buildWorkspaceIndex(root);
  ragIndexes.set(root, index);
  return index;
}
