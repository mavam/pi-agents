/**
 * System-prompt catalogs injected via before_agent_start: the agent catalog
 * (from agents.ts) plus a compact workflow catalog — name, description,
 * trigger, and params only, never flow bodies.
 */

import type { Scope } from "../model/ast.js";
import { buildAgentsPrompt } from "./agents.js";
import type { ModelCatalog } from "./models.js";
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

export function buildModelsPrompt(catalog: ModelCatalog): string {
  const note =
    "valid values for agent-node 'model' (omit to inherit the session model); when an id exists under several providers, prefer the earlier provider";
  const lines = [`<models note="${escapeXmlAttribute(note)}">`];
  if (catalog.providers.length === 0) {
    lines.push("  <none>No available models were discovered.</none>");
  } else {
    for (const provider of catalog.providers) {
      const auth = provider.subscription ? "subscription" : "api-key";
      lines.push(
        `  <provider id="${escapeXmlAttribute(provider.id)}" auth="${auth}">${escapeXmlText(provider.modelIds.join(", "))}</provider>`,
      );
    }
  }
  lines.push("</models>");
  return lines.join("\n");
}

export function buildWorkflowsPrompt(
  cwd: string,
  scope: Scope = "both",
): string {
  const { workflows, diagnostics } = discoverWorkflows(cwd, scope);
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
      if (wf.trigger) {
        lines.push(`    <trigger>${escapeXmlText(wf.trigger)}</trigger>`);
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
export function buildSystemPromptAppendix(
  cwd: string,
  trusted = true,
  catalog?: ModelCatalog,
): string {
  const scope: Scope = trusted ? "both" : "user";
  const agents = buildAgentsPrompt(cwd, scope);
  const workflows = buildWorkflowsPrompt(cwd, scope);
  const parts = [
    "The following reusable agent profiles are available to the `workflow` tool (optional: agent leaves without `name` run as anonymous ad-hoc agents):",
    agents.prompt,
    "",
    "The following saved workflows can be invoked with `workflow({name, params})` when the user asks for a workflow or for delegation. This catalog is a reference, not an invitation: a workflow existing for a task is never by itself a reason to run one.",
    workflows,
  ];
  if (catalog) {
    parts.push(
      "",
      "The following models are available to delegated agents:",
      buildModelsPrompt(catalog),
    );
  }
  if (!trusted) {
    parts.push(
      "",
      "Note: this project is not trusted, so project-local agents and workflows (.pi/agents, .pi/workflows) are hidden and cannot run.",
    );
  }
  return parts.join("\n");
}
