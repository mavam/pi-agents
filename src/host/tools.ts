/**
 * The tools agents work with: pi-durable's `read`, `write`, `edit`, and
 * `bash`, plus Pi's `grep`, `find`, and `ls` adapted to pi-durable. The
 * adapted tools only read, so a rerun after a crash is safe.
 */

import type { JsonValue } from "@earendil-works/chord";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  defineExtension,
  defineTool,
  type Extension,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-durable/tools";

export const TOOLS_EXTENSION = "pi-agents-tools";

/** Every tool name agents can use, in Pi's order. */
export const AGENT_TOOL_NAMES = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;

export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

/** Pi's default selection. */
export const DEFAULT_AGENT_TOOLS: readonly AgentToolName[] = [
  "read",
  "bash",
  "edit",
  "write",
];

export function isAgentToolName(name: string): name is AgentToolName {
  return (AGENT_TOOL_NAMES as readonly string[]).includes(name);
}

// biome-ignore lint/suspicious/noExplicitAny: Pi's tool definitions vary in schema.
type AnyDefinition = ToolDefinition<any, any>;

const DEFINITIONS: Record<AgentToolName, (cwd: string) => AnyDefinition> = {
  read: createReadToolDefinition,
  bash: createBashToolDefinition,
  edit: createEditToolDefinition,
  write: createWriteToolDefinition,
  grep: createGrepToolDefinition,
  find: createFindToolDefinition,
  ls: createLsToolDefinition,
};

/** Pi's prompt snippet and guidelines for a tool, so agents read like Pi. */
export function toolPromptContribution(name: string): {
  snippet?: string;
  guidelines: readonly string[];
} {
  if (!isAgentToolName(name)) return { guidelines: [] };
  const definition = DEFINITIONS[name](process.cwd());
  return {
    snippet: definition.promptSnippet,
    guidelines: definition.promptGuidelines ?? [],
  };
}

function toJson(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

/** Run one of Pi's read-only tools against the call's environment. */
function adaptReadOnly(
  create: (cwd: string) => AnyDefinition,
): ToolRegistration {
  const template = create(process.cwd());
  return defineTool({
    name: template.name,
    description: template.description,
    parameters: template.parameters,
    replay: "safe",
    async execute(args, api, context) {
      const cwd = api.env?.cwd;
      if (cwd === undefined) throw new Error("No execution environment");
      const result = await create(cwd).execute(
        api.callId,
        args,
        context.abortSignal,
        undefined,
        // Pi's built-in tools never use the extension context.
        undefined as never,
      );
      const details = toJson(result.details);
      return {
        content: result.content,
        ...(details === undefined ? {} : { details }),
      };
    },
  });
}

export function createToolsExtension(): Extension {
  return defineExtension({
    name: TOOLS_EXTENSION,
    tools: [
      createReadTool(),
      createBashTool(),
      createEditTool(),
      createWriteTool(),
      adaptReadOnly(createGrepToolDefinition),
      adaptReadOnly(createFindToolDefinition),
      adaptReadOnly(createLsToolDefinition),
    ],
  });
}
