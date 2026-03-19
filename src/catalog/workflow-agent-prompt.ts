import type { Agent, Scope } from "./agents.js";
import { discoverAgents } from "./agents.js";

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

function sortAgentsForWorkflowPrompt(agents: Agent[]): Agent[] {
  return [...agents].sort((left, right) => {
    if (left.source !== right.source) {
      return left.source === "project" ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
}

function formatWorkflowAgentExample(agentName?: string): {
  valid?: string;
  invalidCasing?: string;
  invalidInvented: string;
} {
  if (!agentName) {
    return {
      invalidInvented:
        '{"agent":"invented-agent","task":"Map the public API."}',
    };
  }

  const invalidCasing =
    agentName.toLowerCase() === agentName.toUpperCase()
      ? undefined
      : `{"agent":"${agentName.toUpperCase()}","task":"Map the public API."}`;

  return {
    valid: `{"agent":"${agentName}","task":"Map the public API."}`,
    invalidCasing,
    invalidInvented: '{"agent":"invented-agent","task":"Map the public API."}',
  };
}

export function formatWorkflowAgentsXml(cwd: string, scope: Scope): string {
  const discovery = discoverAgents(cwd, scope);
  const agents = sortAgentsForWorkflowPrompt(discovery.agents);
  const examples = formatWorkflowAgentExample(agents[0]?.name);

  const lines = [
    `<workflow-agents scope="${escapeXmlAttribute(scope)}" cwd="${escapeXmlAttribute(cwd)}">`,
    "  <rules>",
    "    <rule>Use only agent names listed in this block for workflow agent fields.</rule>",
    "    <rule>Any other name is invalid. Do not invent agent names.</rule>",
    "    <rule>If none of these agents fit, explain the limitation instead of fabricating a new one.</rule>",
    "    <rule>Agent names are exact identifiers. Prefer them verbatim.</rule>",
    "    <rule>Agent metadata below is loaded from the discovered agent markdown files for the current cwd and scope.</rule>",
    "  </rules>",
    "  <agents>",
  ];

  if (agents.length === 0) {
    lines.push(
      "    <none>No workflow agents were discovered for this cwd and scope.</none>",
    );
  } else {
    for (const agent of agents) {
      lines.push(
        `    <agent name="${escapeXmlAttribute(agent.name)}" source="${escapeXmlAttribute(agent.source)}" location="${escapeXmlAttribute(agent.filePath)}">`,
        "      <frontmatter>",
        `        <description>${escapeXmlText(agent.description)}</description>`,
      );
      if (agent.model) {
        lines.push(`        <model>${escapeXmlText(agent.model)}</model>`);
      }
      if (agent.thinking) {
        lines.push(
          `        <thinking>${escapeXmlText(agent.thinking)}</thinking>`,
        );
      }
      lines.push("        <skills>");
      if (agent.skills.length === 0) {
        lines.push("          <none>(none)</none>");
      } else {
        for (const skill of agent.skills) {
          lines.push(`          <skill>${escapeXmlText(skill)}</skill>`);
        }
      }
      lines.push("        </skills>", "      </frontmatter>", "    </agent>");
    }
  }

  lines.push("  </agents>");

  if (discovery.diagnostics.length > 0) {
    lines.push("  <diagnostics>");
    for (const diagnostic of discovery.diagnostics) {
      lines.push(
        `    <diagnostic source="${escapeXmlAttribute(diagnostic.source)}" path="${escapeXmlAttribute(diagnostic.filePath)}">${escapeXmlText(diagnostic.message)}</diagnostic>`,
      );
    }
    lines.push("  </diagnostics>");
  }

  lines.push("  <examples>");
  if (examples.valid) {
    lines.push(`    <valid>${escapeXmlText(examples.valid)}</valid>`);
  }
  if (examples.invalidCasing) {
    lines.push(
      `    <invalid reason="invalid-casing">${escapeXmlText(examples.invalidCasing)}</invalid>`,
    );
  }
  lines.push(
    `    <invalid reason="invented-name">${escapeXmlText(examples.invalidInvented)}</invalid>`,
    "  </examples>",
    "</workflow-agents>",
  );

  return lines.join("\n");
}

export function shouldInjectWorkflowAgentsPrompt(
  prompt: string,
  options?: { workflowUsedInPreviousTurn?: boolean },
): boolean {
  if (options?.workflowUsedInPreviousTurn) return true;

  const normalized = prompt.toLowerCase();
  const patterns = [
    /\bworkflow\b/,
    /\bmulti[-\s]?agent\b/,
    /\bspawn\s+\d+\s+(?:agents?|workers?)\b/,
    /\bfork\b/,
    /\bjoin\b/,
    /\bloop\b/,
    /\bparallel(?:ly)?\b.*\b(?:agents?|workers?|branches?)\b/,
    /\b(?:agents?|workers?|branches?)\b.*\bparallel(?:ly)?\b/,
  ];

  return patterns.some((pattern) => pattern.test(normalized));
}
