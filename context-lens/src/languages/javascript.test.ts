import assert from "node:assert/strict";
import { test } from "node:test";
import { javascriptAdapter } from "./javascript.js";

const extract = javascriptAdapter.extractDependencies;
const targets = javascriptAdapter.findCodeLensTargets;

test("extracts a top-level function declaration", () => {
  const doc = `function add(a, b) {\n  return a + b;\n}\n`;
  const result = extract(doc, doc);
  assert.equal(result.functionName, "add");
  assert.equal(result.isMethod, false);
  assert.equal(result.isNested, false);
  assert.match(result.rawCode, /^function add/);
});

test("extracts a top-level arrow function assigned via const", () => {
  const doc = `export const add = (a, b) => {\n  return a + b;\n};\n`;
  const result = extract(doc, doc);
  assert.equal(result.functionName, "add");
  assert.equal(result.isMethod, false);
  assert.match(result.rawCode, /^add = \(a, b\)/);
});

test("extracts TypeScript param types and return type", () => {
  const doc = `function add(a: number, b: number): number {\n  return a + b;\n}\n`;
  const result = extract(doc, doc);
  assert.deepEqual(result.paramTypes, { a: "number", b: "number" });
  assert.equal(result.returnType, "number");
});

test("detects a class method when given the whole class", () => {
  const doc = `class Greeter {\n  constructor(name) {\n    this.name = name;\n  }\n\n  greet(loud) {\n    return loud ? this.name.toUpperCase() : this.name;\n  }\n}\n`;
  const result = extract(doc, doc, "greet");
  assert.equal(result.functionName, "greet");
  assert.equal(result.isMethod, true);
  assert.equal(result.className, "Greeter");
  assert.match(result.rawCode, /^greet\(loud\)/);
  assert.doesNotMatch(result.rawCode, /constructor/);
});

test("detects an async class method and a static method", () => {
  const doc = `class Api {\n  async fetchUser(id) {\n    return id;\n  }\n\n  static create() {\n    return new Api();\n  }\n}\n`;
  const fetchResult = extract(doc, doc, "fetchUser");
  assert.equal(fetchResult.isMethod, true);
  assert.equal(fetchResult.className, "Api");

  const staticResult = extract(doc, doc, "create");
  assert.equal(staticResult.isMethod, true);
  assert.equal(staticResult.className, "Api");
});

test("detects a class field defined as an arrow function", () => {
  const doc = `class Widget {\n  onClick = () => {\n    console.log("clicked");\n  };\n}\n`;
  const result = extract(doc, doc, "onClick");
  assert.equal(result.isMethod, true);
  assert.equal(result.className, "Widget");
});

test("detects a nested function (function inside function) as neither a method nor top-level", () => {
  const doc = `function outer(x) {\n  function inner(y) {\n    return x + y;\n  }\n  return inner(1);\n}\n`;
  const result = extract(doc, doc, "inner");
  assert.equal(result.functionName, "inner");
  assert.equal(result.isMethod, false);
  assert.equal(result.isNested, true);
});

test("throws when focusSymbol isn't found in the slice", () => {
  const doc = `function a() {}\n`;
  assert.throws(() => extract(doc, doc, "b"), /Could not find a function or method named "b"/);
});

test("throws when no function definition is present", () => {
  assert.throws(() => extract("const x = 1;", "const x = 1;"), /not a complete JavaScript\/TypeScript function definition/);
});

test("ignores braces and keywords inside strings and comments", () => {
  const doc = `// function fakeOne() {}\nfunction real() {\n  const s = "function fakeTwo() { return 1; }";\n  return s;\n}\n`;
  const result = extract(doc, doc);
  assert.equal(result.functionName, "real");
  assert.match(result.rawCode, /return s;/);
});

test("only reports imports actually used in the function body", () => {
  const doc = `import { readFile } from "node:fs";\nimport { unused } from "somewhere";\n\nfunction load(path) {\n  return readFile(path);\n}\n`;
  const result = extract(doc, doc);
  assert.deepEqual(result.importedDependencies, ["readFile"]);
});

test("findCodeLensTargets locates a top-level function, a nested function, and both class methods with correct containers", () => {
  const doc = [
    "function outer(x) {",
    "  function inner(y) {",
    "    return x + y;",
    "  }",
    "  return inner(1);",
    "}",
    "",
    "class Calc {",
    "  add(a, b) {",
    "    return a + b;",
    "  }",
    "",
    "  sub(a, b) {",
    "    return a - b;",
    "  }",
    "}"
  ].join("\n");

  const results = targets(doc);
  const names = results.map((r) => r.symbolName).sort();
  assert.deepEqual(names, ["add", "inner", "outer", "sub"]);

  const outer = results.find((r) => r.symbolName === "outer")!;
  assert.equal(outer.containerStartLine, 0);

  const inner = results.find((r) => r.symbolName === "inner")!;
  assert.equal(inner.containerStartLine, 0); // nested: container is the whole outer function
  assert.equal(inner.containerEndLine, 6);

  const add = results.find((r) => r.symbolName === "add")!;
  assert.equal(add.containerStartLine, 7); // method: container is the whole class
  assert.equal(add.containerEndLine, 16);

  const sub = results.find((r) => r.symbolName === "sub")!;
  assert.equal(sub.containerStartLine, 7);
  assert.equal(sub.containerEndLine, 16);
});

test("typescriptAdapter shares extraction logic and only differs in runtime settings", async () => {
  const { typescriptAdapter } = await import("./javascript.js");
  assert.equal(typescriptAdapter.runnableFileExtension, ".ts");
  assert.deepEqual(typescriptAdapter.runArgs("test.ts"), ["--experimental-strip-types", "--test", "test.ts"]);
  assert.equal(javascriptAdapter.runnableFileExtension, ".mjs");
  assert.deepEqual(javascriptAdapter.runArgs("test.mjs"), ["--test", "test.mjs"]);
});
