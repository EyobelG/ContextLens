import * as vscode from "vscode";
import { explainIssues } from "./diagnosticsGenerator.js";
import { DiagnosticFinding } from "./diagnosticsParser.js";
import { FunctionTestCodeLensProvider } from "./codeLensProvider.js";
import { getAdapterForLanguageId, SUPPORTED_VSCODE_LANGUAGE_IDS } from "./languages/registry.js";
import { LanguageAdapter } from "./languages/types.js";
import { WorkspaceRagIndex } from "./ragEngine.js";
import { synthesizeVerifiedTests } from "./testGenerator.js";

const ragIndexes = new Map<string, WorkspaceRagIndex>();

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("ContextLens");
  const diagnostics = vscode.languages.createDiagnosticCollection("contextLens");
  const watcher = vscode.workspace.createFileSystemWatcher("**/*.{py,pyi,js,jsx,mjs,cjs,ts,tsx}");
  const invalidateIndex = (uri: vscode.Uri) => {
    const root = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
    if (!root) return;
    for (const key of [...ragIndexes.keys()]) if (key.startsWith(`${root}::`)) ragIndexes.delete(key);
  };
  watcher.onDidCreate(invalidateIndex);
  watcher.onDidChange(invalidateIndex);
  watcher.onDidDelete(invalidateIndex);

  context.subscriptions.push(
    output,
    diagnostics,
    watcher,
    vscode.languages.registerCodeLensProvider(
      SUPPORTED_VSCODE_LANGUAGE_IDS.map((language) => ({ language })),
      new FunctionTestCodeLensProvider()
    ),
    vscode.commands.registerCommand("contextLens.generateTest", (rawCodeArg?: string, focusSymbolArg?: string) =>
      generateTest(rawCodeArg, focusSymbolArg, output)
    ),
    vscode.commands.registerCommand("contextLens.explainIssues", (rawCodeArg?: string, focusSymbolArg?: string) =>
      runExplainIssues(rawCodeArg, focusSymbolArg, output, diagnostics)
    )
  );
}

export function deactivate(): void {
  ragIndexes.clear();
}

function getActiveAdapter(): { editor: vscode.TextEditor; adapter: LanguageAdapter } | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return undefined;
  const adapter = getAdapterForLanguageId(editor.document.languageId);
  if (!adapter) return undefined;
  return { editor, adapter };
}

async function generateTest(rawCodeArg: string | undefined, focusSymbolArg: string | undefined, output: vscode.OutputChannel): Promise<void> {
  const active = getActiveAdapter();
  if (!active) {
    vscode.window.showErrorMessage("ContextLens: open a supported file first (Python, JavaScript, or TypeScript).");
    return;
  }
  const { editor, adapter } = active;

  const rawCode = rawCodeArg ?? editor.document.getText(editor.selection);
  if (!rawCode.trim()) {
    vscode.window.showErrorMessage("ContextLens: select a function, or use the CodeLens action above a function definition.");
    return;
  }

  try {
    const dependencies = adapter.extractDependencies(editor.document.getText(), rawCode, focusSymbolArg);

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "ContextLens", cancellable: true },
      async (progress, token) => {
        const index = await getWorkspaceIndex(editor.document.uri, adapter, (message) => {
          output.appendLine(message);
          progress.report({ message });
        });

        const result = await synthesizeVerifiedTests(rawCode, dependencies, adapter, index, (message) => {
          output.appendLine(message);
          progress.report({ message });
        }, token);

        const commentPrefix = adapter.lineCommentPrefix;
        const analysisComment = result.analysis
          ? `${commentPrefix} ContextLens analysis of "${dependencies.functionName}":\n${result.analysis.split("\n").map((line) => `${commentPrefix} ${line}`).join("\n")}\n\n`
          : "";
        const document = await vscode.workspace.openTextDocument({ language: editor.document.languageId, content: `${analysisComment}${result.tests}` });
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
    handleError(error, output);
  }
}

async function runExplainIssues(rawCodeArg: string | undefined, focusSymbolArg: string | undefined, output: vscode.OutputChannel, diagnostics: vscode.DiagnosticCollection): Promise<void> {
  const active = getActiveAdapter();
  if (!active) {
    vscode.window.showErrorMessage("ContextLens: open a supported file first (Python, JavaScript, or TypeScript).");
    return;
  }
  const { editor, adapter } = active;

  const rawCode = rawCodeArg ?? editor.document.getText(editor.selection);
  if (!rawCode.trim()) {
    vscode.window.showErrorMessage("ContextLens: select a function, or use the CodeLens action above a function definition.");
    return;
  }

  try {
    const documentText = editor.document.getText();
    const dependencies = adapter.extractDependencies(documentText, rawCode, focusSymbolArg);

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "ContextLens", cancellable: true },
      async (progress, token) => {
        const index = await getWorkspaceIndex(editor.document.uri, adapter, (message) => {
          output.appendLine(message);
          progress.report({ message });
        });

        const findings = await explainIssues(rawCode, dependencies, adapter, index, (message) => {
          output.appendLine(message);
          progress.report({ message });
        }, token);

        const startLine = findRawCodeStartLine(documentText, dependencies.rawCode);
        const vsDiagnostics = findings.map((finding) => toDiagnostic(finding, editor.document, startLine));
        diagnostics.set(editor.document.uri, vsDiagnostics);

        output.appendLine(`\nExplain Issues for "${dependencies.functionName}": ${findings.length} finding(s).`);
        for (const finding of findings) output.appendLine(`  [${finding.severity}] line ${finding.line}: ${finding.message}`);

        vscode.window.showInformationMessage(
          vsDiagnostics.length === 0
            ? `ContextLens: no issues found in "${dependencies.functionName}".`
            : `ContextLens: found ${vsDiagnostics.length} issue${vsDiagnostics.length === 1 ? "" : "s"} in "${dependencies.functionName}" — see Problems panel.`
        );
      }
    );
  } catch (error) {
    handleError(error, output);
  }
}

function toDiagnostic(finding: DiagnosticFinding, document: vscode.TextDocument, rawCodeStartLine: number): vscode.Diagnostic {
  const line = Math.min(rawCodeStartLine + finding.line - 1, document.lineCount - 1);
  const severity = finding.severity === "error"
    ? vscode.DiagnosticSeverity.Error
    : finding.severity === "warning"
      ? vscode.DiagnosticSeverity.Warning
      : vscode.DiagnosticSeverity.Information;
  const diagnostic = new vscode.Diagnostic(document.lineAt(line).range, finding.message, severity);
  diagnostic.source = "ContextLens";
  return diagnostic;
}

/** `rawCode` is always an exact substring of the full document text (see language adapters). */
function findRawCodeStartLine(documentText: string, rawCode: string): number {
  const offset = documentText.indexOf(rawCode);
  if (offset === -1) return 0;
  let line = 0;
  for (let i = 0; i < offset; i += 1) if (documentText[i] === "\n") line += 1;
  return line;
}

function handleError(error: unknown, output: vscode.OutputChannel): void {
  if (error instanceof vscode.CancellationError) {
    output.appendLine("Cancelled by user.");
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  output.appendLine(`Error: ${message}`);
  output.show(true);
  vscode.window.showErrorMessage(`ContextLens: ${message}`);
}

async function getWorkspaceIndex(documentUri: vscode.Uri, adapter: LanguageAdapter, report: (message: string) => void): Promise<WorkspaceRagIndex> {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri) ?? vscode.workspace.workspaceFolders?.[0];
  const root = workspaceFolder?.uri.fsPath ?? "";
  const key = `${root}::${adapter.id}`;
  const cached = ragIndexes.get(key);
  if (cached) return cached;

  report("Indexing workspace for context...");
  const index = new WorkspaceRagIndex(adapter);
  await index.buildWorkspaceIndex(root);
  ragIndexes.set(key, index);
  return index;
}
