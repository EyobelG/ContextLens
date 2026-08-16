export interface DiagnosticFinding {
  /** 1-indexed line number, relative to the start of the focus code block (its own first line is 1). */
  line: number;
  severity: "error" | "warning" | "info";
  message: string;
}

export function parseFindings(raw: string, focusCode: string): DiagnosticFinding[] {
  let parsed: unknown;
  try { parsed = JSON.parse(extractJson(raw)); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const maxLine = focusCode.split("\n").length;
  const findings: DiagnosticFinding[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const { line, severity, message } = item as Record<string, unknown>;
    if (typeof message !== "string" || !message.trim()) continue;
    const parsedLine = typeof line === "number" && Number.isFinite(line) ? Math.min(Math.max(1, Math.round(line)), maxLine) : 1;
    const parsedSeverity = severity === "error" || severity === "warning" || severity === "info" ? severity : "info";
    findings.push({ line: parsedLine, severity: parsedSeverity, message: message.trim() });
  }
  return findings;
}

function extractJson(value: string): string {
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const arrayMatch = value.match(/\[[\s\S]*\]/);
  return arrayMatch ? arrayMatch[0] : value.trim();
}
