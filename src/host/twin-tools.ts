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
 *
 * A catalog of the tools, stored with the agents, stands in for the twin
 * while it starts: agents and calls that resume find their tools at once,
 * and a call parks until the twin signals that its server connected.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import {
  defineDoc,
  defineExtension,
  defineSignal,
  defineTool,
  type Extension,
  GenerationTask,
  type Harness,
  hook,
  type Registry,
  section,
  type TaskId,
  type ToolExecutionResult,
  type ToolNamespace,
  type ToolPark,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { CODEMODE_TOOL_NAME } from "@earendil-works/pi-durable/codemode";
import {
  createToolSearchTool,
  TOOL_SEARCH_TOOL_NAME,
} from "@earendil-works/pi-durable/tool-search";
import { type TSchema, Type } from "typebox";
import type { ToolTwin, TwinResult, TwinTool } from "./twin.js";

export const TWIN_EXTENSION = "pi-agents-twin";

const CONTEXT = BACKGROUND_CONTEXT;

/** The extension of a namespace's tools. */
const NAMESPACE_EXTENSION = `${TWIN_EXTENSION}/`;

/** Whether `name` is the extension of one of the twin's namespaces. */
export function isTwinNamespace(name: string): boolean {
  return name.startsWith(NAMESPACE_EXTENSION);
}

/** How often the twin's tools are compared while nothing else syncs them,
 * as servers connect, reconnect, or change their tools. */
const SYNC_INTERVAL_MS = 2_000;

/** How long a parked call sleeps at most before it looks for its tool
 * again, in case nothing signals it, as after a restart. */
const RECHECK_MS = 5_000;

/** How long a call waits for its tool at most, whatever the twin does. */
const PARK_LIMIT_MS = 60_000;

/** One of the twin's tools as agents saw it last. */
type CatalogTool = {
  name: string;
  description: string;
  parameters: JsonValue;
  deferred: boolean;
  replaySafe: boolean;
  namespace?: { name: string; description: string; instructions?: string };
};

type TwinCatalog = { tools: CatalogTool[] };

/** The twin's tools when its startup last ended, which stand in for them
 * while it starts again. */
export const TwinCatalogDoc = defineDoc<TwinCatalog>({
  kind: "pi-agents.twin-catalog",
  version: 1,
  scope: "session",
  initial: () => ({ tools: [] }),
  // Each change replaces the whole catalog.
  checkpointWhen: () => true,
});

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

function toJson(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function textOf(result: TwinResult): string {
  return result.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
}

/** First line of a namespace's description, as Pi lists MCP servers. */
function summary(text: string | undefined): string {
  return (text?.split("\n", 1)[0] ?? "").trim();
}

/** A live tool as the catalog keeps it; undefined for parameters JSON
 * can't hold. */
function entryOf({ info, definition }: TwinTool): CatalogTool | undefined {
  const parameters = toJson(definition.parameters);
  if (parameters === undefined) return undefined;
  const hints = info.annotations;
  const namespace = info.namespace;
  return {
    name: info.name,
    description: definition.description,
    parameters,
    // A tool the twin declares only to codemode scripts or tool search.
    deferred: info.exposure !== "direct",
    // Whether rerunning a call after a crash is harmless, as its author says.
    replaySafe: hints?.readOnlyHint === true || hints?.idempotentHint === true,
    ...(namespace
      ? {
          namespace: {
            name: namespace.name,
            description: summary(namespace.description),
            ...(namespace.instructions
              ? { instructions: namespace.instructions }
              : {}),
          },
        }
      : {}),
  };
}

function failure(text: string): ToolExecutionResult {
  return { output: [{ type: "text", text }], isError: true };
}

/** What a parked call keeps: when it first looked for its tool, and how
 * often it parked, which names the key it waits on. */
type ParkState = { since: number; parks: number };

/** Tells a parked call that its tool arrived, or that it won't. */
const TwinToolReady = defineSignal({
  name: "pi-agents.twin-tool",
  version: 1,
  schema: Type.Object({}),
});

/** What signals the calls parked for the twin's tools. */
type Signaller = Pick<Harness, "signal">;

/**
 * The servers whose tools agents reach only from scripts or by search, so
 * agents without codemode know of them, as Pi's `mcp_servers` section
 * tells the model. Codemode lists them itself.
 */
function namespacesSection(tools: readonly CatalogTool[]): string[] {
  const namespaces = new Map<string, string>();
  for (const tool of tools)
    if (tool.deferred && tool.namespace)
      namespaces.set(tool.namespace.name, tool.namespace.description);
  return [...namespaces]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, text]) => (text ? `- ${name}: ${text}` : `- ${name}`));
}

const NAMESPACES_INTRO =
  "Tool namespaces whose tools are not declared to you, such as MCP servers. Load their tools with `tool_search`; they are available from your next call.";

/**
 * The extensions that hold the twin's tools. Agents select them from the
 * start, also while they are empty, as without a twin.
 */
export class TwinTools {
  private base: Extension = defineExtension({ name: TWIN_EXTENSION });
  private namespaced: Extension[] = [];
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
  /** The catalog's tools that stand in for the twin's. */
  private standIns: CatalogTool[] = [];
  /** The catalog as stored, to write it only when it changed. */
  private stored = "";
  private persist: ((catalog: TwinCatalog) => Promise<void>) | undefined;
  private harness: Signaller | undefined;
  private persisting: Promise<void> = Promise.resolve();
  private report: (error: unknown) => void = () => {};
  /** Whether no twin is starting: its servers connected, failed, or took
   * too long, or there is none. */
  private settled = true;
  private resolveStarted: () => void = () => {};
  private started: Promise<void> = Promise.resolve();
  /** The signature of the tools the catalog stored last. */
  private storedSignature = "";
  /** Calls parked for a tool, by task: their stand-ins stay until they
   * woke. */
  private readonly parked = new Map<
    number,
    { name: string; key: string; signaled: boolean }
  >();
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

  /** Call `listener` when namespaces come or go. */
  onNamespaces(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Install the extensions in `registry` from now on. */
  attach(registry: Registry): void {
    this.registry = registry;
    this.sync();
  }

  /**
   * Stand in for the twin with `catalog` until its startup ended, keep the
   * catalog current with `persist` from then on, and wake parked calls
   * through `harness`.
   */
  restore(
    catalog: TwinCatalog | undefined,
    options: {
      persist: (catalog: TwinCatalog) => Promise<void>;
      harness: Signaller;
      report: (error: unknown) => void;
    },
  ): void {
    this.standIns = catalog?.tools ?? [];
    this.stored = JSON.stringify(catalog?.tools ?? []);
    this.persist = options.persist;
    this.harness = options.harness;
    this.report = options.report;
    this.sync();
  }

  /** A twin starts: until it settles, the catalog stands in for it. */
  start(): void {
    if (!this.settled) return;
    this.settled = false;
    this.started = new Promise((resolve) => {
      this.resolveStarted = resolve;
    });
  }

  /** Follow `twin`'s tools from now on. */
  connect(twin: ToolTwin): void {
    this.twin = twin;
    this.sync();
    this.timer = setInterval(() => this.sync(), SYNC_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** The twin's startup ended: the stand-ins go, and the catalog follows
   * the twin's tools. */
  settle(): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveStarted();
    this.sync();
  }

  /** Write no more of the catalog, once what is being written is stored. */
  async flush(): Promise<void> {
    this.persist = undefined;
    await this.persisting;
  }

  detach(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.registry = undefined;
    this.twin = undefined;
    this.persist = undefined;
    this.settle();
    this.harness = undefined;
  }

  /** While a twin starts without a catalog of its tools, wait until it
   * settled, as Pi's first prompt waits for its servers. */
  async ready(): Promise<void> {
    if (this.settled || this.standIns.length > 0) return;
    await this.started;
  }

  /** Install the twin's tools again when they changed. */
  sync(): void {
    const registry = this.registry;
    if (!registry) return;
    const twin = this.twin;
    const live = twin?.tools() ?? [];
    const entries = live.flatMap((tool) => {
      const entry = entryOf(tool);
      return entry ? [{ entry, tool }] : [];
    });
    const names = new Set(entries.map(({ entry }) => entry.name));
    const standIns = this.standIns.filter(
      (tool) =>
        !names.has(tool.name) &&
        (!this.settled ||
          [...this.parked.values()].some((call) => call.name === tool.name)),
    );
    const signature = JSON.stringify([
      entries.map(({ entry, tool }) => [
        entry.name,
        entry.deferred,
        entry.namespace,
        revisionOf(tool.definition),
      ]),
      standIns.map((tool) => tool.name),
    ]);
    if (signature !== this.signature) {
      this.signature = signature;
      this.install(
        registry,
        [
          ...entries.map(({ entry, tool }) => this.proxy(entry, tool)),
          ...standIns.map((entry) => this.proxy(entry, undefined)),
        ],
        [...entries.map(({ entry }) => entry), ...standIns],
      );
    }
    if (this.settled && signature !== this.storedSignature) {
      this.storedSignature = signature;
      this.store(entries.map(({ entry }) => entry));
    }
    this.wake(names);
  }

  /** Signal the parked calls whose tool arrived, and all of them once the
   * startup ended: those won't get theirs. */
  private wake(live: ReadonlySet<string>): void {
    const harness = this.harness;
    if (!harness) return;
    for (const [task, call] of this.parked) {
      if (call.signaled || !(this.settled || live.has(call.name))) continue;
      call.signaled = true;
      harness
        .signal(task as TaskId, TwinToolReady, call.key, {}, CONTEXT)
        .catch((error) => this.report(error));
    }
  }

  private install(
    registry: Registry,
    proxies: ToolRegistration[],
    catalog: CatalogTool[],
  ): void {
    const ungrouped: ToolRegistration[] = [];
    const groups = new Map<
      string,
      { namespace: ToolNamespace; tools: ToolRegistration[] }
    >();
    catalog.forEach((entry, index) => {
      const tool = proxies[index] as ToolRegistration;
      if (!entry.namespace) {
        ungrouped.push(tool);
        return;
      }
      const group = groups.get(entry.namespace.name);
      if (group) group.tools.push(tool);
      else
        groups.set(entry.namespace.name, {
          namespace: entry.namespace,
          tools: [tool],
        });
    });
    const listing = namespacesSection(catalog);
    const deferred = proxies.some((tool) => tool.deferred === true);
    this.base = defineExtension({
      name: TWIN_EXTENSION,
      tools: [...ungrouped, ...(deferred ? [this.search] : [])],
      sections:
        listing.length > 0
          ? [
              section("tool_namespaces", (input) => {
                const names = new Set(
                  input.agent.tools.map((tool) => tool.name),
                );
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
          beforeRequest: async () => {
            this.sync();
            await this.ready();
            return undefined;
          },
        }),
      ],
    });
    registry.install(this.base);
    const before = this.namespaced.map((extension) => extension.name);
    const next = [...groups.values()]
      .sort((a, b) => a.namespace.name.localeCompare(b.namespace.name))
      .map(({ namespace, tools }) =>
        defineExtension({
          name: `${NAMESPACE_EXTENSION}${namespace.name}`,
          namespace,
          tools,
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

  /** Store the catalog when it changed, one write after another. */
  private store(tools: CatalogTool[]): void {
    const persist = this.persist;
    const text = JSON.stringify(tools);
    if (!persist || text === this.stored) return;
    this.stored = text;
    this.persisting = this.persisting
      .then(() => persist({ tools }))
      .catch((error) => this.report(error));
  }

  /** The tool agents call; `live` is the twin's, absent for a stand-in. */
  private proxy(entry: CatalogTool, live: TwinTool | undefined) {
    const definition = live?.definition;
    return defineTool({
      name: entry.name,
      description: entry.description,
      parameters: entry.parameters as unknown as TSchema,
      ...(entry.deferred ? { deferred: true as const } : {}),
      // Tools reach other systems; only their authors know a rerun is safe.
      replay: entry.replaySafe ? "safe" : "unsafe",
      ...(definition?.prepareArguments
        ? { prepareArguments: definition.prepareArguments }
        : {}),
      execute: async (
        args,
        api,
        context,
      ): Promise<ToolExecutionResult | ToolPark> => {
        const parked = api.checkpoint as ParkState | undefined;
        this.parked.delete(api.taskId);
        const twin = this.twin;
        if (!twin?.tool(entry.name)) {
          // Its server may connect yet: wait for it, parked, until the twin
          // signals that it did or that its startup ended.
          const since = parked?.since ?? api.now();
          if (this.settled || api.now() - since >= PARK_LIMIT_MS)
            return failure(
              `${entry.name} isn't available: its server isn't connected`,
            );
          const parks = (parked?.parks ?? 0) + 1;
          // A key serves one wait, so each park has its own.
          const key = `${entry.name}#${parks}`;
          this.parked.set(api.taskId, {
            name: entry.name,
            key,
            signaled: false,
          });
          return {
            sleep: {
              until: Math.min(api.now() + RECHECK_MS, since + PARK_LIMIT_MS),
              signals: [TwinToolReady.key(key)],
              checkpoint: { since, parks } satisfies ParkState,
            },
          };
        }
        // Progress arrives as the result so far: show what it adds.
        let shown = "";
        const result = await twin.call(
          entry.name,
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
      cancel: async (_args, api) => {
        this.parked.delete(api.taskId);
      },
    });
  }
}
