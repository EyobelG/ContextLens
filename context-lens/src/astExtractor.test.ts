import assert from "node:assert/strict";
import { test } from "node:test";
import { extractPythonDependencies } from "./astExtractor.js";

test("extracts a top-level function's signature and used imports", () => {
  const doc = `import math\nimport os\n\ndef add(a: int, b: int = 1) -> int:\n    return a + b\n`;
  const raw = `def add(a: int, b: int = 1) -> int:\n    return a + b`;
  const result = extractPythonDependencies(doc, raw);

  assert.equal(result.functionName, "add");
  assert.equal(result.isMethod, false);
  assert.equal(result.className, undefined);
  assert.deepEqual(result.paramTypes, { a: "int", b: "int" });
  assert.equal(result.returnType, "int");
  assert.deepEqual(result.importedDependencies, []); // math/os aren't referenced in the body
});

test("only reports imports actually used in the function body", () => {
  const doc = `import math\nimport os\n\ndef area(r):\n    return math.pi * r * r\n`;
  const raw = `def area(r):\n    return math.pi * r * r`;
  const result = extractPythonDependencies(doc, raw);
  assert.deepEqual(result.importedDependencies, ["math"]); // "os" is unused and correctly excluded
});

test("handles from-imports with aliasing", () => {
  const doc = `from collections import OrderedDict as OD\n\ndef make():\n    return OD()\n`;
  const raw = `def make():\n    return OD()`;
  const result = extractPythonDependencies(doc, raw);
  assert.deepEqual(result.importedDependencies, ["collections.OrderedDict"]);
});

test("supports async def", () => {
  const doc = `async def fetch(url: str) -> str:\n    return url\n`;
  const result = extractPythonDependencies(doc, doc);
  assert.equal(result.functionName, "fetch");
});

test("throws when no function definition is present", () => {
  assert.throws(() => extractPythonDependencies("x = 1", "x = 1"), /not a complete Python function definition/);
});

test("throws when focusSymbol isn't found in the slice", () => {
  const doc = `def a():\n    pass\n`;
  assert.throws(() => extractPythonDependencies(doc, doc, "b"), /Could not find a function or method named "b"/);
});

test("detects a class method when given the enclosing class text, and dedents-free rawCode stays as the method block", () => {
  const doc = `class Greeter:\n    def __init__(self, name):\n        self.name = name\n\n    def greet(self, loud: bool = False) -> str:\n        text = f"hello {self.name}"\n        return text.upper() if loud else text\n`;
  const classSlice = doc; // whole class, as codeLensProvider would send for a method
  const result = extractPythonDependencies(doc, classSlice, "greet");

  assert.equal(result.functionName, "greet");
  assert.equal(result.isMethod, true);
  assert.equal(result.className, "Greeter");
  assert.deepEqual(result.paramTypes, { self: undefined, loud: "bool" });
  assert.equal(result.returnType, "str");
  assert.match(result.rawCode, /^def greet/);
  assert.doesNotMatch(result.rawCode, /__init__/);
});

test("focusSymbol picks the right method among several", () => {
  const doc = `class Calc:\n    def add(self, a, b):\n        return a + b\n\n    def sub(self, a, b):\n        return a - b\n`;
  const result = extractPythonDependencies(doc, doc, "sub");
  assert.equal(result.functionName, "sub");
  assert.match(result.rawCode, /return a - b/);
});

test("a bare method selection without the class wrapper is not misidentified as a free function's class", () => {
  // Only the method text was selected (no class line present in the slice); className can't be
  // recovered from the slice alone, but the extractor should still succeed since it looks at the
  // full document text to find the enclosing class.
  const doc = `class Box:\n    def volume(self, w, h, d):\n        return w * h * d\n`;
  const methodOnly = `    def volume(self, w, h, d):\n        return w * h * d`;
  const result = extractPythonDependencies(doc, methodOnly);
  assert.equal(result.isMethod, true);
  assert.equal(result.className, "Box");
});

test("detects a nested function (def inside def) as neither a method nor top-level", () => {
  const doc = `def outer(x):\n    def inner(y):\n        return x + y\n    return inner(1)\n`;
  const result = extractPythonDependencies(doc, doc, "inner");
  assert.equal(result.functionName, "inner");
  assert.equal(result.isMethod, false);
  assert.equal(result.isNested, true);
});

test("top-level and method functions are not flagged as nested", () => {
  const topLevel = extractPythonDependencies("def f():\n    pass\n", "def f():\n    pass\n");
  assert.equal(topLevel.isNested, false);

  const doc = "class C:\n    def m(self):\n        pass\n";
  const method = extractPythonDependencies(doc, doc, "m");
  assert.equal(method.isNested, false);
  assert.equal(method.isMethod, true);
});

test("splits parameters on top-level commas only, respecting nested brackets", () => {
  const doc = "def f(a: List[int, str] = [], b: dict = {}) -> None:\n    pass\n";
  const result = extractPythonDependencies(doc, doc);
  assert.deepEqual(result.paramTypes, { a: "List[int, str]", b: "dict" });
});

test("handles a multi-line function signature", () => {
  const doc = `def f(\n    a: int,\n    b: str = "x",\n) -> bool:\n    return True\n`;
  const result = extractPythonDependencies(doc, doc);
  assert.deepEqual(result.paramTypes, { a: "int", b: "str" });
  assert.equal(result.returnType, "bool");
});
