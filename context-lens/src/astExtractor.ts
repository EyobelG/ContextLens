export interface DependencyMetadata {
  functionName: string;
  paramTypes: Record<string, string | undefined>;
  returnType?: string;
  importedDependencies: string[];
  rawCode: string;
}

/** Extracts useful Python symbols without requiring a Python parser at extension runtime. */
export function extractPythonDependencies(documentText: string, rawCode: string): DependencyMetadata {
  const signature = rawCode.match(/^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?:->\s*([^:]+))?:/m);
  if (!signature) throw new Error("The selected code is not a complete Python function definition.");

  const paramTypes: Record<string, string | undefined> = {};
  for (const parameter of signature[2].split(",").map((part) => part.trim()).filter(Boolean)) {
    const match = parameter.match(/^([A-Za-z_]\w*)\s*(?::\s*([^=]+?))?(?:\s*=.*)?$/);
    if (match) paramTypes[match[1]] = match[2]?.trim();
  }

  const imports = new Map<string, string>();
  const importPattern = /^(?:from\s+([\w.]+)\s+import\s+(.+)|import\s+(.+))$/gm;
  for (const match of documentText.matchAll(importPattern)) {
    if (match[1]) {
      for (const item of match[2].split(",")) {
        const [symbol, alias] = item.trim().split(/\s+as\s+/);
        imports.set(alias ?? symbol, `${match[1]}.${symbol}`);
      }
    } else {
      for (const item of match[3].split(",")) {
        const [module, alias] = item.trim().split(/\s+as\s+/);
        imports.set(alias ?? module.split(".")[0], module);
      }
    }
  }
  const used = [...imports].filter(([name]) => new RegExp(`\\b${escapeRegExp(name)}\\b`).test(rawCode));
  return { functionName: signature[1], paramTypes, returnType: signature[3]?.trim(), importedDependencies: used.map(([, source]) => source), rawCode };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
