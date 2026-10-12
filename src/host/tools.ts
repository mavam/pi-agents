/**
 * The tools agents work with: pi-durable's `read`, `write`, `edit`, `bash`,
 * and `codemode`, plus Pi's `grep`, `find`, and `ls` adapted to pi-durable.
 * The adapted tools only read, so a rerun after a crash is safe.
 */

import type { JsonValue } from "@earendil-works/chord";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
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
  type PromptSection,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
  CODEMODE_TOOL_NAME,
  createCodemodeExtension,
} from "@earendil-works/pi-durable/codemode";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type ImageProcessor,
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
  "codemode",
] as const;

export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

/** Pi's default selection. */
export const DEFAULT_AGENT_TOOLS: readonly AgentToolName[] = [
  "read",
  "bash",
  "edit",
  "write",
];

type PiToolName = Exclude<AgentToolName, "codemode">;

function isPiToolName(name: string): name is PiToolName {
  return (
    name !== "codemode" &&
    (AGENT_TOOL_NAMES as readonly string[]).includes(name)
  );
}

// biome-ignore lint/suspicious/noExplicitAny: Pi's tool definitions vary in schema.
type AnyDefinition = ToolDefinition<any, any>;

const DEFINITIONS: Record<PiToolName, (cwd: string) => AnyDefinition> = {
  read: createReadToolDefinition,
  bash: createBashToolDefinition,
  edit: createEditToolDefinition,
  write: createWriteToolDefinition,
  grep: createGrepToolDefinition,
  find: createFindToolDefinition,
  ls: createLsToolDefinition,
};

/** Pi's prompt contribution of its `codemode` tool, which Pi doesn't export. */
const CODEMODE_PROMPT = {
  snippet: "Run JavaScript that calls other tools",
  guidelines: [
    "Use codemode to batch independent tool calls (Promise.allSettled), chain them, or filter large output, instead of many separate calls.",
  ],
};

/** Pi's prompt snippet and guidelines for a tool, so agents read like Pi. */
export function toolPromptContribution(name: string): {
  snippet?: string;
  guidelines: readonly string[];
} {
  if (name === CODEMODE_TOOL_NAME) return CODEMODE_PROMPT;
  if (!isPiToolName(name)) return { guidelines: [] };
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
        output: result.content,
        ...(details === undefined ? {} : { details }),
      };
    },
  });
}

/** Photon, loaded with the first image `read` prepares. */
function lazyImages(): ImageProcessor {
  let processor: Promise<ImageProcessor> | undefined;
  return {
    async prepare(bytes, mimeType, limits) {
      processor ??= createNodePhotonImages();
      return (await processor).prepare(bytes, mimeType, limits);
    },
  };
}

export interface ToolsExtension {
  extension: Extension;
  /** Stop the scripts that run; they resume in the next process. */
  close(): Promise<void>;
}

/**
 * The tools of agents. `codemode` scripts call the agent's other tools as
 * nested calls, which pi-durable replays after a restart. Its prompt
 * section lists those tools only for agents that have `codemode`. Scripts
 * get no `models.*`, whose internal tools agents would have to select too.
 */
export function createToolsExtension(): ToolsExtension {
  // Like Pi, scripts have no deadline unless they ask for one.
  const sandbox = new CodemodeSandbox({ timeoutMs: Number.POSITIVE_INFINITY });
  const codemode = createCodemodeExtension({ sandbox, models: false });
  const sections = (codemode.sections ?? []).map(
    (each): PromptSection => ({
      ...each,
      render: (input, context) =>
        input.agent.tools.some((tool) => tool.name === CODEMODE_TOOL_NAME)
          ? each.render(input, context)
          : undefined,
    }),
  );
  const extension = defineExtension({
    name: TOOLS_EXTENSION,
    tools: [
      createReadTool({ images: lazyImages() }),
      createBashTool(),
      createEditTool(),
      createWriteTool(),
      adaptReadOnly(createGrepToolDefinition),
      adaptReadOnly(createFindToolDefinition),
      adaptReadOnly(createLsToolDefinition),
      ...(codemode.tools ?? []),
    ],
    sections,
  });
  return { extension, close: () => sandbox.close() };
}
