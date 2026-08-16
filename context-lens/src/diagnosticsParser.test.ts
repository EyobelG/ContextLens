import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFindings } from "./diagnosticsParser.js";

const focusCode = "function f(x) {\n  return x / 0;\n}"; // 3 lines

test("parses a clean JSON array", () => {
  const raw = `[{"line": 2, "severity": "error", "message": "Division by zero is possible."}]`;
  const findings = parseFindings(raw, focusCode);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 2);
  assert.equal(findings[0].severity, "error");
  assert.match(findings[0].message, /Division by zero/);
});

test("strips a markdown code fence around the JSON", () => {
  const raw = "```json\n[{\"line\": 1, \"severity\": \"warning\", \"message\": \"no input validation\"}]\n```";
  const findings = parseFindings(raw, focusCode);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "warning");
});

test("returns an empty array for invalid JSON", () => {
  assert.deepEqual(parseFindings("not json at all", focusCode), []);
});

test("returns an empty array when the model reports no issues", () => {
  assert.deepEqual(parseFindings("[]", focusCode), []);
});

test("clamps out-of-range line numbers into the focus code's line count", () => {
  const raw = `[{"line": 999, "severity": "info", "message": "too high"}, {"line": -5, "severity": "info", "message": "too low"}]`;
  const findings = parseFindings(raw, focusCode);
  assert.equal(findings[0].line, 3); // clamped to max line count
  assert.equal(findings[1].line, 1); // clamped to minimum of 1
});

test("defaults an invalid severity to info and skips entries without a message", () => {
  const raw = `[{"line": 1, "severity": "critical", "message": "weird severity"}, {"line": 2, "message": ""}]`;
  const findings = parseFindings(raw, focusCode);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
});
