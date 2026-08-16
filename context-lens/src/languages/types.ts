export interface DependencyMetadata {
  functionName: string;
  className?: string;
  isMethod: boolean;
  /** True when nested inside another function/method (not a class) — not independently callable. */
  isNested: boolean;
  paramTypes: Record<string, string | undefined>;
  returnType?: string;
  importedDependencies: string[];
  rawCode: string;
}

/** A function/method CodeLens should be placed on, and the source range to send for generation. */
export interface CodeLensTarget {
  /** 0-indexed line (in the full document) where the CodeLens itself should be anchored. */
  line: number;
  /** 0-indexed inclusive start line of the block to send as source (may be a whole class/outer function). */
  containerStartLine: number;
  /** 0-indexed exclusive end line of that block. */
  containerEndLine: number;
  symbolName: string;
}

export type ChunkKind = "test" | "fixture" | "model" | "source";

/**
 * Everything language-specific lives behind this interface: how to find functions/methods for
 * CodeLens, how to extract structured metadata from a source slice, how to chunk/classify files
 * for RAG indexing, and how to actually run generated tests in a sandbox.
 */
export interface LanguageAdapter {
  id: string;
  vscodeLanguageIds: string[];
  displayName: string;
  frameworkName: string;
  fileExtensionPattern: RegExp;
  testFileNamePattern: RegExp;
  runnableFileExtension: string;
  codeFencePattern: RegExp;
  lineCommentPrefix: string;
  stopwords: Set<string>;
  runnerSettingKey: "pythonPath" | "nodePath";
  defaultRunnerPath: string;

  findCodeLensTargets(documentText: string): CodeLensTarget[];
  extractDependencies(documentText: string, sourceSlice: string, focusSymbol?: string): DependencyMetadata;
  splitIntoChunks(content: string): Array<{ symbol?: string; content: string }>;
  classifyFile(fileName: string, content: string): ChunkKind;
  buildRunnableSource(sourceCode: string, testCode: string): string;
  runArgs(testFilePath: string): string[];
}
