import * as vscode from "vscode";

const DEF_PATTERN = /^[ \t]*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*(?:->\s*[^:]+)?:/gm;
const CLASS_PATTERN = /^[ \t]*class\s+/;

export class FunctionTestCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const lenses: vscode.CodeLens[] = [];
    for (const match of document.getText().matchAll(DEF_PATTERN)) {
      const defLine = document.positionAt(match.index ?? 0).line;
      const indent = document.lineAt(defLine).firstNonWhitespaceCharacterIndex;
      const functionName = match[1];

      if (indent === 0) {
        lenses.push(makeLens(defLine, sliceBlock(document, defLine, indent), functionName));
        continue;
      }

      // Indented def: slice from its outermost container — the enclosing class if there is one,
      // otherwise the top-level function it's nested inside — so the sandbox sees valid, complete
      // Python (a bare indented `def` on its own is a SyntaxError at module scope).
      const container = findOuterContainer(document, defLine, indent);
      lenses.push(makeLens(defLine, sliceBlock(document, container.line, container.indent), functionName));
    }
    return lenses;
  }
}

function makeLens(line: number, source: string, functionName: string): vscode.CodeLens {
  return new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
    title: "🧪 Generate & Verify Tests",
    command: "contextLens.generateTest",
    arguments: [source, functionName]
  });
}

function sliceBlock(document: vscode.TextDocument, start: number, indent: number): string {
  const end = findBlockEnd(document, start, indent);
  const lastLine = Math.max(start, end - 1);
  const range = new vscode.Range(start, 0, lastLine, document.lineAt(lastLine).text.length);
  return document.getText(range);
}

function findBlockEnd(document: vscode.TextDocument, start: number, indent: number): number {
  let line = start + 1;
  while (line < document.lineCount) {
    const current = document.lineAt(line);
    if (current.text.trim() && current.firstNonWhitespaceCharacterIndex <= indent) break;
    line += 1;
  }
  return line;
}

/**
 * Climbs from an indented `def` up through its ancestors. Stops as soon as it reaches a `class`
 * line (that's the natural container for a method) or indentation 0 (a plain nested function's
 * outermost enclosing function), whichever comes first.
 */
function findOuterContainer(document: vscode.TextDocument, line: number, indent: number): { line: number; indent: number } {
  let currentLine = line;
  let currentIndent = indent;
  while (currentIndent > 0) {
    const ancestor = findNearestLowerIndentLine(document, currentLine, currentIndent);
    if (ancestor === undefined) break;
    currentLine = ancestor;
    currentIndent = document.lineAt(ancestor).firstNonWhitespaceCharacterIndex;
    if (CLASS_PATTERN.test(document.lineAt(ancestor).text)) break;
  }
  return { line: currentLine, indent: currentIndent };
}

function findNearestLowerIndentLine(document: vscode.TextDocument, fromLine: number, belowIndent: number): number | undefined {
  for (let line = fromLine - 1; line >= 0; line -= 1) {
    const current = document.lineAt(line);
    if (!current.text.trim()) continue;
    const currentIndent = current.firstNonWhitespaceCharacterIndex;
    if (currentIndent >= belowIndent) continue;
    return line;
  }
  return undefined;
}
