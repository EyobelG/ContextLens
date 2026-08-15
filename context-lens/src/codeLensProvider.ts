import * as vscode from "vscode";

export class FunctionTestCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const lenses: vscode.CodeLens[] = [];
    const expression = /^(?:async\s+)?def\s+[A-Za-z_]\w*\s*\([^)]*\)\s*(?:->\s*[^:]+)?:/gm;
    for (const match of document.getText().matchAll(expression)) {
      const start = document.positionAt(match.index ?? 0).line;
      const end = findFunctionEnd(document, start);
      const range = new vscode.Range(start, 0, Math.max(start, end - 1), document.lineAt(Math.max(start, end - 1)).text.length);
      lenses.push(new vscode.CodeLens(new vscode.Range(start, 0, start, 0), {
        title: "🧪 Generate & Verify Tests", command: "contextLens.generateTest", arguments: [document.getText(range)]
      }));
    }
    return lenses;
  }
}

function findFunctionEnd(document: vscode.TextDocument, start: number): number {
  const indent = document.lineAt(start).firstNonWhitespaceCharacterIndex;
  let line = start + 1;
  while (line < document.lineCount) {
    const current = document.lineAt(line);
    if (current.text.trim() && current.firstNonWhitespaceCharacterIndex <= indent) break;
    line += 1;
  }
  return line;
}
