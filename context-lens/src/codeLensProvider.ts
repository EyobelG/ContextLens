import * as vscode from "vscode";
import { getAdapterForLanguageId } from "./languages/registry.js";

export class FunctionTestCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const adapter = getAdapterForLanguageId(document.languageId);
    if (!adapter) return [];

    const lenses: vscode.CodeLens[] = [];
    for (const target of adapter.findCodeLensTargets(document.getText())) {
      const lastContainerLine = Math.max(target.containerStartLine, target.containerEndLine - 1);
      const containerRange = new vscode.Range(target.containerStartLine, 0, lastContainerLine, document.lineAt(lastContainerLine).text.length);
      const source = document.getText(containerRange);
      const anchor = new vscode.Range(target.line, 0, target.line, 0);

      lenses.push(new vscode.CodeLens(anchor, {
        title: "🧪 Generate & Verify Tests",
        command: "contextLens.generateTest",
        arguments: [source, target.symbolName]
      }));
      lenses.push(new vscode.CodeLens(anchor, {
        title: "🔎 Explain Issues",
        command: "contextLens.explainIssues",
        arguments: [source, target.symbolName]
      }));
    }
    return lenses;
  }
}
