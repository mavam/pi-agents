import type { Scope } from "./agents.js";

export function toDiagnosticText(
  scope: Scope,
  diagnostics: Array<{ filePath: string; message: string }>,
): string[] {
  const prefix = `scope=${scope}`;
  return diagnostics.map((d) => `${prefix}: ${d.filePath}: ${d.message}`);
}
