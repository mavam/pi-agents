/**
 * The tool twin's tools as pi-durable tools agents call: one proxy per
 * tool, in an extension every agent selects with all of its tools. Tools
 * MCP declares only to codemode stay deferred, so scripts call them and the
 * model learns of their servers from a prompt section, as in Pi.
 *
 * The twin's tools change as servers connect, so the extension is installed
 * again whenever they do; agents select it by name.
 */

import type { JsonValue } from "@earendil-works/chord";
import {
  defineExtension,
  defineTool,
  type Extension,
  GenerationTask,
  hook,
  type Registry,
  section,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { CodemodeNamespace } from "@earendil-works/pi-durable/codemode";
import { CODEMODE_TOOL_NAME } from "@earendil-works/pi-durable/codemode";
import type { TSchema } from "typebox";
import type { ToolTwin, TwinResult, TwinTool } from "./twin.js";

export const TWIN_EXTENSION = "pi-agents-twin";

/** A tool the twin declares only to codemode scripts or tool search. */
function isDeferred(tool: TwinTool): boolean {
  return tool.info.exposure !== "direct";
}

/** Whether rerunning a call after a crash is harmless, as its author says. */
function replaySafe(tool: TwinTool): boolean {
  const hints = tool.info.annotations;
  return hints?.readOnlyHint === true || hints?.idempotentHint === true;
}

function toJson(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function textOf(result: TwinResult): string {
  return result.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
}

function proxy(twin: ToolTwin, tool: TwinTool): ToolRegistration {
  const { definition } = tool;
  return defineTool({
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters as TSchema,
    ...(isDeferred(tool) ? { deferred: true as const } : {}),
    // Tools reach other systems; only their authors know a rerun is safe.
    replay: replaySafe(tool) ? "safe" : "unsafe",
    ...(definition.prepareArguments
      ? { prepareArguments: definition.prepareArguments }
      : {}),
    async execute(args, api, context): Promise<ToolExecutionResult> {
      // Progress arrives as the result so far: show what it adds.
      let shown = "";
      const result = await twin.call(
        definition.name,
        args as Record<string, unknown>,
        context.abortSignal,
        (partial) => {
          const text = textOf(partial);
          if (!text || text === shown) return;
          api.output(
            text.startsWith(shown) ? text.slice(shown.length) : `\n${text}`,
          );
          shown = text;
        },
      );
      const details = toJson(result.details);
      return {
        output: result.content,
        ...(details === undefined ? {} : { details }),
        ...(result.isError ? { isError: true } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
      };
    },
  });
}

/** First line of a namespace's description, as Pi lists MCP servers. */
function summary(text: string | undefined): string {
  return (text?.split("\n", 1)[0] ?? "").trim();
}

/**
 * The servers whose tools agents reach only from scripts, so the model
 * knows of them, as Pi's `mcp_servers` section tells it.
 */
function namespacesSection(tools: readonly TwinTool[]): string | undefined {
  const namespaces = new Map<string, string>();
  for (const tool of tools) {
    const namespace = tool.info.namespace;
    if (!isDeferred(tool) || !namespace) continue;
    namespaces.set(namespace.name, summary(namespace.description));
  }
  if (namespaces.size === 0) return undefined;
  const lines = [...namespaces]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, text]) => (text ? `- ${name}: ${text}` : `- ${name}`));
  return [
    "Tool namespaces whose tools are not declared to you, such as MCP servers. Call their tools from codemode scripts; find them with `searchTools()` and `describeNamespace()`.",
    ...lines,
  ].join("\n");
}

/** The twin's namespaces for codemode, one per tool, so each tool belongs
 * exactly to its own. */
function codemodeNamespaces(tools: readonly TwinTool[]): CodemodeNamespace[] {
  return tools.flatMap(({ info }) =>
    info.namespace
      ? [
          {
            name: info.namespace.name,
            prefix: info.name,
            ...(info.namespace.description
              ? { description: info.namespace.description }
              : {}),
            ...(info.namespace.instructions
              ? { instructions: info.namespace.instructions }
              : {}),
          },
        ]
      : [],
  );
}

/**
 * The extension that holds the twin's tools. Agents select it from the
 * start, also while it is empty, as without a twin.
 */
export class TwinTools {
  /** Codemode's namespaces, which the tools extension reads at each use. */
  readonly namespaces: CodemodeNamespace[] = [];
  private current: Extension = defineExtension({ name: TWIN_EXTENSION });
  private signature = "";
  private registry: Registry | undefined;
  private twin: ToolTwin | undefined;

  /** The extension as installed now. */
  get extension(): Extension {
    return this.current;
  }

  /** The names of the twin's tools, which agents always get. */
  names(): string[] {
    return (this.current.tools ?? []).map((tool) => tool.name);
  }

  /** Follow `twin` in `registry` from now on. */
  attach(registry: Registry, twin: ToolTwin | undefined): void {
    this.registry = registry;
    this.twin = twin;
    this.sync();
  }

  detach(): void {
    this.registry = undefined;
    this.twin = undefined;
  }

  /** Install the twin's tools again when they changed. */
  sync(): void {
    const registry = this.registry;
    if (!registry) return;
    const twin = this.twin;
    const tools = twin?.tools() ?? [];
    const signature = JSON.stringify(
      tools.map(({ info }) => [info.name, info.exposure, info.namespace?.name]),
    );
    if (signature === this.signature) return;
    this.signature = signature;
    const proxies = twin
      ? tools.flatMap((tool) => {
          try {
            return [proxy(twin, tool)];
          } catch {
            // A schema pi-durable can't take; the other tools still work.
            return [];
          }
        })
      : [];
    this.namespaces.splice(
      0,
      this.namespaces.length,
      ...codemodeNamespaces(tools),
    );
    const listing = namespacesSection(tools);
    this.current = defineExtension({
      name: TWIN_EXTENSION,
      tools: proxies,
      sections: listing
        ? [
            section("tool_namespaces", (input) =>
              input.agent.tools.some((tool) => tool.name === CODEMODE_TOOL_NAME)
                ? listing
                : undefined,
            ),
          ]
        : [],
      // Servers that connect later reach agents at their next request.
      hooks: [
        hook(GenerationTask, {
          beforeRequest: () => {
            this.sync();
            return undefined;
          },
        }),
      ],
    });
    registry.install(this.current);
  }
}
