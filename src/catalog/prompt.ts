/**
 * System-prompt catalogs injected via before_agent_start: the agent catalog
 * (from agents.ts) plus a compact workflow catalog — name, description,
 * whenToUse, and params only, never flow bodies.
 */

import { buildAgentsPrompt } from "./agents.js";
import { discoverWorkflows } from "./workflows.js";

function escapeXmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value)
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function buildWorkflowsPrompt(cwd: string): string {
  const { workflows, diagnostics } = discoverWorkflows(cwd, "both");
  const lines = [`<workflows cwd="${escapeXmlAttribute(cwd)}">`];
  if (workflows.length === 0) {
    lines.push("  <none>No saved workflows were discovered.</none>");
  } else {
    for (const wf of workflows) {
      lines.push(
        `  <workflow name="${escapeXmlAttribute(wf.name)}" source="${escapeXmlAttribute(wf.source)}">`,
      );
      lines.push(
        `    <description>${escapeXmlText(wf.description)}</description>`,
      );
      if (wf.whenToUse) {
        lines.push(`    <whenToUse>${escapeXmlText(wf.whenToUse)}</whenToUse>`);
      }
      if (wf.params.length > 0) {
        lines.push("    <params>");
        for (const param of wf.params) {
          const attrs = [
            `name="${escapeXmlAttribute(param.name)}"`,
            param.required ? 'required="true"' : undefined,
            param.default !== undefined
              ? `default="${escapeXmlAttribute(param.default)}"`
              : undefined,
          ]
            .filter(Boolean)
            .join(" ");
          lines.push(
            `      <param ${attrs}>${escapeXmlText(param.description ?? "")}</param>`,
          );
        }
        lines.push("    </params>");
      }
      lines.push("  </workflow>");
    }
  }
  if (diagnostics.length > 0) {
    lines.push("  <diagnostics>");
    for (const diagnostic of diagnostics) {
      lines.push(
        `    <diagnostic path="${escapeXmlAttribute(diagnostic.filePath)}">${escapeXmlText(diagnostic.message)}</diagnostic>`,
      );
    }
    lines.push("  </diagnostics>");
  }
  lines.push("</workflows>");
  return lines.join("\n");
}

/** The full appendix injected into the system prompt every turn. */
export function buildSystemPromptAppendix(cwd: string): string {
  const agents = buildAgentsPrompt(cwd, "both");
  const workflows = buildWorkflowsPrompt(cwd);
  return [
    "The following delegated agents are available to the `workflow` tool:",
    agents.prompt,
    "",
    "The following saved workflows can be invoked with `workflow({name, params})`:",
    workflows,
  ].join("\n");
}
