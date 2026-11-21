/**
 * The tool twin's tools as pi-durable tools agents call: one proxy per
 * tool. Tools MCP declares only to codemode stay deferred, so scripts call
 * them, as in Pi.
 *
 * Each namespace, such as an MCP server, gets an extension of its own, so
 * codemode lists it with its description and `describeNamespace()` returns
 * its instructions. Tools without a namespace, `tool_search`, and the
 * namespace listing for agents without codemode are in the base extension.
 * The twin's tools change as servers connect, so the extensions are
 * installed again whenever they do; agents select them by name, and the
 * service updates their selection as namespaces come and go.
 */

import type { JsonValue } from "@earendil-works/chord/json";
import {
  defineExtension,
  defineTool,
  type Extension,
  GenerationTask,
  hook,
  type Registry,
  section,
  type ToolExecutionResult,
  type ToolNamespace,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { CODEMODE_TOOL_NAME } from "@earendil-works/pi-durable/codemode";
import {
  createToolSearchTool,
  TOOL_SEARCH_TOOL_NAME,
} from "@earendil-works/pi-durable/tool-search";
import type { TSchema } from "typebox";
import type { ToolPromptContribution } from "./tools.js";
import type { ToolTwin, TwinResult, TwinTool } from "./twin.js";

export const TWIN_EXTENSION = "pi-agents-twin";

/** The extension of a namespace's tools. */
const NAMESPACE_EXTENSION = `${TWIN_EXTENSION}/`;

/** Whether `name` is the extension of one of the twin's namespaces. */
export function isTwinNamespace(name: string): boolean {
  return name.startsWith(NAMESPACE_EXTENSION);
}

/** How often the twin's tools are compared while nothing else syncs them,
 * as servers connect, reconnect, or change their tools. */
const SYNC_INTERVAL_MS = 2_000;

/** Pi registers a tool again with a new definition when it changes, such
 * as when its server reconnects: an identity per definition tells them
 * apart. */
const revisions = new WeakMap<object, number>();
let nextRevision = 0;

function revisionOf(definition: object): number {
  let revision = revisions.get(definition);
  if (revision === undefined) {
    nextRevision += 1;
    revision = nextRevision;
    revisions.set(definition, revision);
  }
  return revision;
}

/** A tool the twin declares only to codemode scripts or tool search. */
function isDeferred(tool: TwinTool): boolean {
  return tool.info.exposure !== "direct";
}

/** Whether rerunning a call after a crash is harmless, as its author says. */
function replaySafe(tool: TwinTool): boolean {
  const hints = tool.info.annotations;
  return hints?.readOnlyHint === true || hints?.idempotentHint === true;
}

/** A tool's output schema when it is a JSON Schema object pi-durable accepts. */
function outputSchemaOf(
  definition: TwinTool["definition"],
): object | undefined {
  const schema: unknown = definition.outputSchema;
  return typeof schema === "object" && schema !== null && !Array.isArray(schema)
    ? schema
    : undefined;
}

function toJson(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? undefined : (JSON.parse(json) as JsonValue);
  } catch {
    return undefined;
  }
}

function textOf(result: TwinResult): string {
  return result.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
}

function proxy(twin: ToolTwin, tool: TwinTool): ToolRegistration {
  const { definition } = tool;
  const structuredOutputSchema = outputSchemaOf(definition);
  return defineTool({
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters as TSchema,
    ...(structuredOutputSchema === undefined ? {} : { structuredOutputSchema }),
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
      // Only emit structuredOutput when the tool declares a schema:
      // pi-durable rejects structuredOutput on schema-less tools.
      const structuredOutput =
        structuredOutputSchema === undefined
          ? undefined
          : toJson(result.structuredContent);
      return {
        output: result.content,
        ...(details === undefined ? {} : { details }),
        ...(structuredOutput === undefined ? {} : { structuredOutput }),
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
 * The servers whose tools agents reach only from scripts or by search, so
 * agents without codemode know of them, as Pi's `mcp_servers` section
 * tells the model. Codemode lists them itself.
 */
function namespacesSection(tools: readonly TwinTool[]): string[] | undefined {
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
  return lines;
}

const NAMESPACES_INTRO =
  "Tool namespaces whose tools are not declared to you, such as MCP servers. Load their tools with `tool_search`; they are available from your next call.";

/** A tool's namespace as pi-durable's codemode takes it. */
function namespaceOf(tool: TwinTool): ToolNamespace | undefined {
  const namespace = tool.info.namespace;
  if (!namespace) return undefined;
  return {
    name: namespace.name,
    description: summary(namespace.description),
    ...(namespace.instructions ? { instructions: namespace.instructions } : {}),
  };
}

/** A tool's prompt snippet and guidelines, normalized as Pi normalizes them. */
function promptContributionOf(
  definition: TwinTool["definition"],
): ToolPromptContribution {
  const rawSnippet: unknown = definition.promptSnippet;
  const snippet =
    typeof rawSnippet === "string"
      ? rawSnippet
          .replace(/[\r\n]+/g, " ")
          .replace(/\s+/g, " ")
          .trim()
      : undefined;
  const rawGuidelines: unknown = definition.promptGuidelines;
  const guidelines: string[] = [];
  if (Array.isArray(rawGuidelines)) {
    for (const guideline of rawGuidelines) {
      if (typeof guideline !== "string") continue;
      const normalized = guideline.trim();
      if (normalized && !guidelines.includes(normalized))
        guidelines.push(normalized);
    }
  }
  return {
    ...(snippet ? { snippet } : {}),
    guidelines,
  };
}

/**
 * The extension that holds the twin's tools. Agents select it from the
 * start, also while it is empty, as without a twin.
 */
export class TwinTools {
  private base: Extension = defineExtension({ name: TWIN_EXTENSION });
  private namespaced: Extension[] = [];
  private readonly contributions = new WeakMap<
    ToolRegistration,
    ToolPromptContribution
  >();
  /**
   * `tool_search`, which loads the twin's tools that only scripts reach,
   * for agents without `codemode`, as Pi offers MCP tools either way. It
   * comes with those tools, also to agents created before they connected.
   */
  readonly search: ToolRegistration = createToolSearchTool();
  private signature = "";
  private registry: Registry | undefined;
  private twin: ToolTwin | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly listeners = new Set<() => void>();

  /** The extensions as installed now: the base, then one per namespace. */
  extensions(): Extension[] {
    return [this.base, ...this.namespaced];
  }

  /** The names of the twin's tools, which agents always get. */
  names(): string[] {
    return this.extensions().flatMap((extension) =>
      (extension.tools ?? []).map((tool) => tool.name),
    );
  }

  /** A twin tool registration's prompt snippet and guidelines, when it came from this twin. */
  promptContribution(
    tool: ToolRegistration,
  ): ToolPromptContribution | undefined {
    return this.contributions.get(tool);
  }

  /** Call `listener` when namespaces come or go. */
  onNamespaces(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Install the extensions in `registry` from now on, without a twin
   * until `connect`. */
  attach(registry: Registry): void {
    this.registry = registry;
    this.sync();
  }

  /** Follow `twin`'s tools from now on. */
  connect(twin: ToolTwin): void {
    this.twin = twin;
    this.sync();
    this.timer = setInterval(() => this.sync(), SYNC_INTERVAL_MS);
    this.timer.unref?.();
  }

  detach(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.registry = undefined;
    this.twin = undefined;
    this.signature = "";
  }

  /** Install the twin's tools again when they changed. */
  sync(): void {
    const registry = this.registry;
    if (!registry) return;
    const twin = this.twin;
    const tools = twin?.tools() ?? [];
    const prepared = tools.map((tool) => ({
      tool,
      contribution: promptContributionOf(tool.definition),
    }));
    const signature = JSON.stringify(
      prepared.map(({ tool: { info, definition }, contribution }) => {
        const outputSchema = outputSchemaOf(definition);
        return [
          info.name,
          info.exposure,
          info.namespace?.name,
          revisionOf(definition),
          outputSchema ? revisionOf(outputSchema) : 0,
          contribution.snippet ?? "",
          contribution.guidelines,
        ];
      }),
    );
    if (signature === this.signature) return;
    this.signature = signature;
    const ungrouped: ToolRegistration[] = [];
    const groups = new Map<
      string,
      { namespace: ToolNamespace; tools: ToolRegistration[] }
    >();
    let deferred = false;
    if (twin)
      for (const { tool, contribution } of prepared) {
        let registration: ToolRegistration;
        try {
          registration = proxy(twin, tool);
        } catch {
          // A schema pi-durable can't take; the other tools still work.
          continue;
        }
        this.contributions.set(registration, contribution);
        if (registration.deferred === true) deferred = true;
        const namespace = namespaceOf(tool);
        if (!namespace) {
          ungrouped.push(registration);
          continue;
        }
        const group = groups.get(namespace.name);
        if (group) group.tools.push(registration);
        else groups.set(namespace.name, { namespace, tools: [registration] });
      }
    const listing = namespacesSection(tools);
    this.base = defineExtension({
      name: TWIN_EXTENSION,
      tools: [...ungrouped, ...(deferred ? [this.search] : [])],
      sections: listing
        ? [
            section("tool_namespaces", (input) => {
              const names = new Set(input.agent.tools.map((tool) => tool.name));
              return names.has(TOOL_SEARCH_TOOL_NAME) &&
                !names.has(CODEMODE_TOOL_NAME)
                ? [NAMESPACES_INTRO, ...listing].join("\n")
                : undefined;
            }),
          ]
        : [],
      // Between the timer's syncs, agents see changes at their next request.
      hooks: [
        hook(GenerationTask, {
          beforeRequest: () => {
            this.sync();
            return undefined;
          },
        }),
      ],
    });
    registry.install(this.base);
    const before = this.namespaced.map((extension) => extension.name);
    const next = [...groups.values()]
      .sort((a, b) => a.namespace.name.localeCompare(b.namespace.name))
      .map(({ namespace, tools: grouped }) =>
        defineExtension({
          name: `${NAMESPACE_EXTENSION}${namespace.name}`,
          namespace,
          tools: grouped,
        }),
      );
    const kept = new Set(next.map((extension) => extension.name));
    for (const extension of this.namespaced)
      if (!kept.has(extension.name)) registry.uninstall(extension);
    for (const extension of next) registry.install(extension);
    this.namespaced = next;
    const after = next.map((extension) => extension.name);
    if (JSON.stringify(before) !== JSON.stringify(after))
      for (const listener of this.listeners) listener();
  }
}
