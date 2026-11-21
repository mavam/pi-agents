/**
 * The tool twin: a headless Pi session in this process that runs Pi's own
 * MCP extension and the extensions the user allows, so agents can call
 * their tools. Pi's extension tools only run in a Pi session, and agents
 * run on pi-durable, so the twin is the bridge until Pi offers durable
 * versions of them. It shares Pi's configuration files and sign-ins, but
 * not Pi's connections.
 *
 * The twin only hosts tools: it never prompts a model, has no UI, and keeps
 * its session in memory.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  createAgentSession,
  createMcpExtension,
  DefaultPackageManager,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  getAgentDir,
  type McpExposure,
  type RegisteredCommand,
  type RegisteredMcpServer,
  SessionManager,
  SettingsManager,
  type ToolCallEvent,
  type ToolCallEventResult,
  type ToolDefinition,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** How long waiting gives connecting servers before moving on, as in Pi. */
export const TWIN_STARTUP_WAIT_MS = 10_000;

/** A tool that reaches the MCP servers named in its input, so Pi's MCP
 * extension waits for them before it runs. Hidden: nothing calls it. */
const READY_TOOL = "pi_agents_twin_ready";

const OVERRIDE_KEYS = new Set(["enabled", "exposure", "toolExposure"]);
const EXPOSURES = new Set<McpExposure>([
  "direct",
  "codemode",
  "deferred",
  "hidden",
]);
const EXPOSURE_ALIASES: Readonly<Record<string, McpExposure>> = {
  "codemode-deferred": "codemode",
};
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MCP_RESOURCE_TOOLS = new Set([
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
]);
/** Prefix length before `_<8-hex-hash>` in Pi's 64-char shortened MCP tool names. */
const TRUNCATED_MCP_PREFIX_LEN = 55;
const TRUNCATED_MCP_TOOL = /^mcp__[A-Za-z0-9_]{50}_[0-9a-f]{8}$/;
/** Poll interval used only while a prefix-overlapping server (e.g. `a` vs `a_b`) is connecting. */
const PREFIX_OVERLAP_POLL_MS = 50;

// biome-ignore lint/suspicious/noExplicitAny: Pi's tool definitions vary in schema.
type AnyDefinition = ToolDefinition<any, any>;
type ToolCallHandler = (
  event: ToolCallEvent,
  ctx: ExtensionContext,
) => Promise<ToolCallEventResult | undefined> | ToolCallEventResult | undefined;
type McpCompletions = NonNullable<RegisteredCommand["getArgumentCompletions"]>;

/** A tool of the twin that agents can call. */
export interface TwinTool {
  info: ToolInfo;
  definition: AnyDefinition;
}

/** What a call returns, as Pi's tools return it. */
export type TwinResult = Awaited<ReturnType<AnyDefinition["execute"]>>;

/** An enabled MCP server the twin is connecting to. */
export interface TwinMcpServer {
  /** Server name as configured (for example `"docs"`). */
  name: string;
  /** Namespace scripts and tools use (`mcp__<server>` with `-` as `_`). */
  namespace: string;
  /** One-line description from configuration, when set. */
  description: string;
  /** Whether any of the server's tools are exposed directly to models. */
  hasDirect: boolean;
  /** Whether any of the server's tools are reached via codemode or tool_search. */
  hasIndirect: boolean;
}

/** Which MCP servers a tool call or wait can reach. */
export type McpReach = "all" | "indirect" | readonly string[];

export interface ToolTwinOptions {
  /** The session's directory: where MCP looks for project configuration
   * and runs its servers. */
  cwd: string;
  /** Package sources whose extensions the twin loads, as in Pi's
   * `packages` setting, for example `npm:webfox`. */
  extensions: readonly string[];
  /** Whether the session trusts its project: only then do the project's
   * `mcp.json` and installed packages count, as in Pi. */
  trusted: boolean;
  /** A problem the user should know about; the twin keeps working. */
  onProblem: (message: string) => void;
  /** How long to wait for a connecting MCP server when needed. */
  startupWaitMs?: number;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

/** Namespace of an MCP server, matching Pi's `mcpNamespace()`. */
export function mcpNamespace(server: string): string {
  return `mcp__${server.replace(/-/g, "_")}`;
}

function firstLine(text: unknown): string {
  if (typeof text !== "string") return "";
  return (text.trim().split("\n", 1)[0] ?? "").trim();
}

function isMcpExposure(value: unknown): value is McpExposure {
  return typeof value === "string" && EXPOSURES.has(value as McpExposure);
}

function resolveExposureAlias(value: unknown): unknown {
  return typeof value === "string" ? (EXPOSURE_ALIASES[value] ?? value) : value;
}

function resolveExposureAliases(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = { ...value };
  if (value.exposure !== undefined)
    resolved.exposure = resolveExposureAlias(value.exposure);
  if (isRecord(value.toolExposure)) {
    resolved.toolExposure = Object.fromEntries(
      Object.entries(value.toolExposure).map(([tool, entry]) => [
        tool,
        resolveExposureAlias(entry),
      ]),
    );
  }
  return resolved;
}

function isLoopbackRedirectUri(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    url.protocol === "http:" &&
    LOOPBACK_HOSTS.has(url.hostname) &&
    url.search === "" &&
    url.hash === ""
  );
}

function isCimdCallback(callbackUrl: string | undefined): boolean {
  if (callbackUrl === undefined) return true;
  const url = new URL(callbackUrl);
  return url.hostname !== "[::1]" && url.pathname === "/callback";
}

function isValidOAuth(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  if (value.clientId !== undefined && typeof value.clientId !== "string")
    return false;
  if (
    value.clientSecret !== undefined &&
    typeof value.clientSecret !== "string"
  )
    return false;
  const port = value.callbackPort;
  if (
    port !== undefined &&
    (typeof port !== "number" ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535)
  )
    return false;
  if (value.callbackUrl !== undefined) {
    if (
      typeof value.callbackUrl !== "string" ||
      !isLoopbackRedirectUri(value.callbackUrl)
    )
      return false;
    const urlPort = new URL(value.callbackUrl).port;
    if (urlPort && port !== undefined && Number(urlPort) !== port) return false;
  }
  if (value.scope !== undefined && typeof value.scope !== "string")
    return false;
  if (
    value.clientName !== undefined &&
    (typeof value.clientName !== "string" || !value.clientName.trim())
  )
    return false;
  const registration = value.clientRegistration;
  if (
    registration !== undefined &&
    registration !== "auto" &&
    registration !== "dcr"
  ) {
    if (registration !== "cimd") return false;
    if (value.clientId !== undefined || value.clientName !== undefined)
      return false;
    if (
      !isCimdCallback(
        typeof value.callbackUrl === "string" ? value.callbackUrl : undefined,
      )
    )
      return false;
  }
  const metadataUrl = value.authServerMetadataUrl;
  if (metadataUrl !== undefined) {
    const url =
      typeof metadataUrl === "string" && URL.canParse(metadataUrl)
        ? new URL(metadataUrl)
        : undefined;
    if (
      !url ||
      !(
        url.protocol === "https:" ||
        (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))
      )
    )
      return false;
  }
  return true;
}

function isValidAuth(auth: unknown, url: string): boolean {
  if (auth === undefined) return true;
  if (!isRecord(auth) || typeof auth.provider !== "string" || !auth.provider)
    return false;
  const parsed = new URL(url);
  return parsed.protocol === "https:" || LOOPBACK_HOSTS.has(parsed.hostname);
}

/**
 * Validate one `mcpServers` entry, matching Pi's `validateMcpServerConfig()`
 * (both `pi-mcp` transport/OAuth fields and Pi's exposure/auth fields).
 * Returns the normalized config on success, or `undefined` when invalid.
 */
function validateMcpServerConfig(
  name: string,
  raw: unknown,
): Record<string, unknown> | undefined {
  if (!SERVER_NAME.test(name) || !isRecord(raw)) return undefined;
  const entry = resolveExposureAliases(raw);
  if (entry.enabled !== undefined && typeof entry.enabled !== "boolean")
    return undefined;
  if (entry.description !== undefined && typeof entry.description !== "string")
    return undefined;
  if (
    entry.timeout !== undefined &&
    (typeof entry.timeout !== "number" || !(entry.timeout > 0))
  )
    return undefined;
  const { type, url, command } = entry;
  if (type === "sse") return undefined;
  let kind: "http" | "stdio" | undefined;
  if (
    typeof url === "string" &&
    (type === undefined || type === "http" || type === "streamable-http")
  ) {
    if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol))
      return undefined;
    if (entry.headers !== undefined && !isStringRecord(entry.headers))
      return undefined;
    if (!isValidOAuth(entry.oauth)) return undefined;
    kind = "http";
  } else if (
    typeof command === "string" &&
    (type === undefined || type === "stdio")
  ) {
    if (
      entry.args !== undefined &&
      !(
        Array.isArray(entry.args) &&
        entry.args.every((arg) => typeof arg === "string")
      )
    )
      return undefined;
    if (entry.env !== undefined && !isStringRecord(entry.env)) return undefined;
    if (entry.cwd !== undefined && typeof entry.cwd !== "string")
      return undefined;
    kind = "stdio";
  } else {
    return undefined;
  }
  if (entry.exposure !== undefined && !isMcpExposure(entry.exposure))
    return undefined;
  if (entry.toolExposure !== undefined) {
    if (!isRecord(entry.toolExposure)) return undefined;
    for (const value of Object.values(entry.toolExposure))
      if (!isMcpExposure(value)) return undefined;
  }
  if (kind === "http" && !isValidAuth(entry.auth, url as string))
    return undefined;
  return entry;
}

function toTwinMcpServer(
  name: string,
  config: Record<string, unknown>,
): TwinMcpServer | undefined {
  if (config.enabled === false) return undefined;
  const normalized = resolveExposureAliases(config);
  const exposures = new Set<McpExposure>();
  exposures.add(
    isMcpExposure(normalized.exposure) ? normalized.exposure : "codemode",
  );
  if (isRecord(normalized.toolExposure)) {
    for (const value of Object.values(normalized.toolExposure))
      if (isMcpExposure(value)) exposures.add(value);
  }
  const hasDirect = exposures.has("direct");
  const hasIndirect = exposures.has("codemode") || exposures.has("deferred");
  if (!hasDirect && !hasIndirect) return undefined;
  return {
    name,
    namespace: mcpNamespace(name),
    description: firstLine(normalized.description),
    hasDirect,
    hasIndirect,
  };
}

function readConfigFile(
  filePath: string,
  scope: "global" | "project",
  servers: Map<string, Record<string, unknown>>,
): void {
  if (!fs.existsSync(filePath)) return;
  let parsed: unknown;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    return;
  }
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) return;
  for (const [name, value] of Object.entries(parsed.mcpServers)) {
    const isOverride =
      scope === "project" &&
      isRecord(value) &&
      value.command === undefined &&
      value.url === undefined &&
      value.type === undefined;
    if (isOverride) {
      const base = servers.get(name);
      if (!base) continue;
      if (Object.keys(value).some((key) => !OVERRIDE_KEYS.has(key))) continue;
      const merged = validateMcpServerConfig(name, { ...base, ...value });
      if (merged) servers.set(name, merged);
      continue;
    }
    const config = validateMcpServerConfig(name, value);
    if (!config) continue;
    const namespace = mcpNamespace(name);
    const clash = [...servers.keys()].some(
      (other) => other !== name && mcpNamespace(other) === namespace,
    );
    if (clash) continue;
    if (scope === "project" && "url" in config && config.auth !== undefined)
      continue;
    servers.set(name, config);
  }
}

/** Read configured MCP servers from global and (when trusted) project `mcp.json`. */
function readMcpConfigEntries(
  cwd: string,
  agentDir: string,
  trusted: boolean,
): Map<string, Record<string, unknown>> {
  const servers = new Map<string, Record<string, unknown>>();
  readConfigFile(path.join(agentDir, "mcp.json"), "global", servers);
  if (trusted)
    readConfigFile(path.join(cwd, ".pi", "mcp.json"), "project", servers);
  return servers;
}

/** Merge `mcp.json` entries with extension-registered servers (`mcp.json` wins). */
function mergeMcpServers(
  configured: ReadonlyMap<string, Record<string, unknown>>,
  registered: readonly RegisteredMcpServer[],
): {
  servers: TwinMcpServer[];
  enabledNamespaces: Set<string>;
  registeredConfigs: Map<string, string>;
} {
  const result: TwinMcpServer[] = [];
  const namespaces = new Set<string>();
  const enabledNamespaces = new Set<string>();
  const registeredConfigs = new Map<string, string>();
  for (const [name, config] of configured) {
    const namespace = mcpNamespace(name);
    namespaces.add(namespace);
    if (config.enabled !== false) enabledNamespaces.add(namespace);
    const server = toTwinMcpServer(name, config);
    if (server) result.push(server);
  }
  for (const { name, config } of registered) {
    const namespace = mcpNamespace(name);
    if (namespaces.has(namespace)) continue;
    namespaces.add(namespace);
    registeredConfigs.set(namespace, JSON.stringify(config));
    const raw = config as unknown as Record<string, unknown>;
    if (raw.enabled !== false) enabledNamespaces.add(namespace);
    const server = toTwinMcpServer(name, raw);
    if (server) result.push(server);
  }
  return {
    servers: result.sort((a, b) => a.namespace.localeCompare(b.namespace)),
    enabledNamespaces,
    registeredConfigs,
  };
}

function wordMatchesNamespace(word: string, namespace: string): boolean {
  if (word === namespace || word.startsWith(`${namespace}__`)) return true;
  if (
    namespace.length > TRUNCATED_MCP_PREFIX_LEN - 2 &&
    TRUNCATED_MCP_TOOL.test(word) &&
    word.startsWith(`${namespace}__`.slice(0, TRUNCATED_MCP_PREFIX_LEN))
  )
    return true;
  return false;
}

/** A context view with `signal` replaced, keeping all other properties and getters. */
function withSignal(
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): ExtensionContext {
  return Object.create(ctx, {
    signal: { get: () => signal, configurable: true, enumerable: true },
  }) as ExtensionContext;
}

/** Await `value`, but no longer than until `signal` aborts. */
async function abortable<T>(
  value: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return value;
  signal.throwIfAborted();
  let abort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([value, aborted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/**
 * Wrap Pi's MCP extension to observe tool registrations, isolate its
 * `tool_call` readiness handler from shared extensions, bound resource-tool
 * waits, and notice when `mcp_servers_change` finishes connecting.
 */
function watchedMcpExtension(callbacks: {
  onRegisterTool: (tool: AnyDefinition) => void;
  onToolCallHandler: (handler: ToolCallHandler) => void;
  onMcpCompletions: (completions: McpCompletions) => void;
  runToolCall: (
    event: ToolCallEvent,
    ctx: ExtensionContext,
    handler: ToolCallHandler,
  ) => Promise<ToolCallEventResult | undefined>;
  runServersChange: (event: object, run: () => Promise<void>) => Promise<void>;
}): ExtensionFactory {
  const mcp = createMcpExtension();
  return (pi: ExtensionAPI) => {
    mcp(
      new Proxy(pi, {
        get(target, prop, receiver) {
          if (prop === "registerTool") {
            return (tool: AnyDefinition) => {
              target.registerTool(tool);
              callbacks.onRegisterTool(tool);
            };
          }
          if (prop === "registerCommand") {
            return (
              name: string,
              command: Omit<RegisteredCommand, "name" | "sourceInfo">,
            ) => {
              if (name === "mcp" && command.getArgumentCompletions)
                callbacks.onMcpCompletions(command.getArgumentCompletions);
              target.registerCommand(name, command);
            };
          }
          if (prop === "on") {
            return (
              event: string,
              handler: (...args: unknown[]) => unknown,
            ) => {
              if (event === "tool_call") {
                const raw = handler as ToolCallHandler;
                callbacks.onToolCallHandler(raw);
                return target.on("tool_call", (ev, ctx) =>
                  callbacks.runToolCall(ev, ctx, raw),
                );
              }
              if (event === "mcp_servers_change") {
                return target.on("mcp_servers_change", (ev, ctx) =>
                  callbacks.runServersChange(ev, async () => {
                    await handler(ev, ctx);
                  }),
                );
              }
              return (
                target.on as (
                  event: string,
                  handler: (...args: unknown[]) => unknown,
                ) => unknown
              )(event, handler);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    );
  };
}

/** The twin's own extension: readiness probe and registered MCP server view. */
function probeExtension(callbacks: {
  bind: (getRegistered: () => RegisteredMcpServer[]) => void;
  onServersChange: (event: object) => void;
}): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    callbacks.bind(() => pi.getMcpServers());
    pi.on("mcp_servers_change", (event) => {
      callbacks.onServersChange(event);
    });
    pi.registerTool({
      name: READY_TOOL,
      label: READY_TOOL,
      description: "Waits for reached MCP servers.",
      parameters: Type.Object({
        reach: Type.Optional(
          Type.Union([Type.Literal("all"), Type.Array(Type.String())]),
        ),
      }),
      exposure: "hidden",
      reachesTools: (input) =>
        input.reach === "all" || Array.isArray(input.reach)
          ? input.reach
          : "all",
      async execute() {
        return { content: [], details: undefined };
      },
    });
  };
}

/**
 * Extension paths of the installed packages among `sources`, from the
 * scope Pi installed each in: the project's when it is trusted, else the
 * user's. The twin never installs anything.
 */
async function extensionPaths(
  cwd: string,
  agentDir: string,
  trusted: boolean,
  sources: readonly string[],
  onProblem: (message: string) => void,
): Promise<string[]> {
  if (sources.length === 0) return [];
  const packages = new DefaultPackageManager({
    cwd,
    agentDir,
    settingsManager: SettingsManager.create(cwd, agentDir, {
      projectTrusted: trusted,
    }),
  });
  const project: string[] = [];
  const user: string[] = [];
  for (const source of sources) {
    if (trusted && packages.getInstalledPath(source, "project"))
      project.push(source);
    else if (packages.getInstalledPath(source, "user")) user.push(source);
    else onProblem(`${source} isn't installed; run pi install ${source}`);
  }
  const resolved = [
    ...(project.length > 0
      ? [await packages.resolveExtensionSources(project, { local: true })]
      : []),
    ...(user.length > 0 ? [await packages.resolveExtensionSources(user)] : []),
  ];
  return resolved.flatMap((paths) =>
    paths.extensions
      .filter((resource) => resource.enabled)
      .map((resource) => resource.path),
  );
}

/**
 * Whether a twin would host anything: extensions to load, or an `mcp.json`
 * in Pi's directory or the project. Without them, opening one only costs
 * time.
 */
export function twinWanted(
  cwd: string,
  extensions: readonly string[],
  trusted: boolean,
): boolean {
  return (
    extensions.length > 0 ||
    fs.existsSync(path.join(getAgentDir(), "mcp.json")) ||
    (trusted && fs.existsSync(path.join(cwd, ".pi", "mcp.json")))
  );
}

interface ServerReadiness {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly deadline: number;
  settled: boolean;
  /** True for dynamic registrations until Pi's `mcp_servers_change` finishes
   * closing any replaced transport and creates the new server's connection. */
  awaitingStart: boolean;
}

export class ToolTwin {
  private counter = 0;
  private readonly closed = new AbortController();
  private readonly readiness = new Map<string, ServerReadiness>();
  private readonly changeListeners = new Set<() => void>();
  private readonly activeCallSignals = new Map<
    string,
    AbortSignal | undefined
  >();
  private servers: TwinMcpServer[];
  /** All enabled MCP server namespaces (including `exposure: "hidden"`), for substring-overlap detection. */
  private enabledNamespaces: Set<string>;
  private registeredConfigs: Map<string, string>;
  /** Readiness entries created per `mcp_servers_change` event object. */
  private readonly pendingChangeBatches = new WeakMap<
    object,
    Array<{ name: string; namespace: string; entry: ServerReadiness }>
  >();
  /** All currently in-flight Pi `mcp_servers_change` handlers. */
  private readonly inFlightChanges = new Set<Promise<void>>();
  private version = 0;
  private directWait: Promise<void> | undefined;
  private flushScheduled = false;
  private readonly registeredNamespaces = new Set<string>();
  private prefixTimer: ReturnType<typeof setInterval> | undefined;
  private readonly watchTimers = new Set<ReturnType<typeof setInterval>>();

  private constructor(
    private readonly session: Awaited<
      ReturnType<typeof createAgentSession>
    >["session"],
    private readonly configured: ReadonlyMap<string, Record<string, unknown>>,
    private readonly getRegistered: () => RegisteredMcpServer[],
    private readonly mcpToolCallHandler: ToolCallHandler | undefined,
    private readonly mcpCompletions: McpCompletions | undefined,
    private readonly mcpToolOwners: ReadonlyMap<string, string>,
    private readonly onProblem: (message: string) => void,
    private readonly startupWaitMs: number,
  ) {
    const merged = mergeMcpServers(configured, getRegistered());
    this.servers = merged.servers;
    this.enabledNamespaces = merged.enabledNamespaces;
    this.registeredConfigs = merged.registeredConfigs;
  }

  /** Start the twin; its MCP servers connect in the background. */
  static async open(options: ToolTwinOptions): Promise<ToolTwin> {
    const { cwd, onProblem, trusted } = options;
    const agentDir = getAgentDir();
    const configured = readMcpConfigEntries(cwd, agentDir, trusted);
    const paths = await extensionPaths(
      cwd,
      agentDir,
      trusted,
      options.extensions,
      onProblem,
    );
    let twin: ToolTwin | undefined;
    let getRegistered: () => RegisteredMcpServer[] = () => [];
    let mcpToolCallHandler: ToolCallHandler | undefined;
    let mcpCompletions: McpCompletions | undefined;
    // Track tools and namespaces registered specifically by Pi's MCP
    // extension, so shared extension tools in an `mcp__*` namespace never
    // falsely mark an MCP server ready or route through MCP server matching.
    const mcpRegisteredNamespaces = new Set<string>();
    const mcpToolOwners = new Map<string, string>();
    // No settings of its own: none of the user's packages to resolve, and
    // the session's trust decides whether MCP reads the project's config.
    const settingsManager = SettingsManager.inMemory(
      {},
      { projectTrusted: trusted },
    );
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths: paths,
      // Probe first so mcp_servers_change updates the twin's server list
      // before Pi's MCP extension awaits the new connections.
      extensionFactories: [
        probeExtension({
          bind: (getter) => {
            getRegistered = getter;
          },
          onServersChange: (event) => twin?.refreshServers(event),
        }),
        watchedMcpExtension({
          onRegisterTool: (tool) => {
            if (tool.exposure === "hidden") {
              mcpToolOwners.delete(tool.name);
            } else if (tool.namespace?.name) {
              mcpToolOwners.set(tool.name, tool.namespace.name);
              mcpRegisteredNamespaces.add(tool.namespace.name);
            }
            twin?.onMcpToolRegistered(tool);
          },
          onToolCallHandler: (handler) => {
            mcpToolCallHandler = handler;
          },
          onMcpCompletions: (completions) => {
            mcpCompletions = completions;
          },
          runToolCall: (event, ctx, handler) =>
            twin
              ? twin.runMcpToolCall(event, ctx, handler)
              : Promise.resolve(handler(event, ctx)),
          runServersChange: (event, run) =>
            twin ? twin.runServersChange(event, run) : run(),
        }),
      ],
    });
    await resourceLoader.reload();
    for (const { path, error } of resourceLoader.getExtensions().errors)
      onProblem(`the tool twin couldn't load ${path}: ${error}`);
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      settingsManager,
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
      noTools: "builtin",
    });
    await session.bindExtensions({
      onError: (error) =>
        onProblem(
          `the tool twin's ${error.extensionPath} failed: ${message(error.error)}`,
        ),
    });
    twin = new ToolTwin(
      session,
      configured,
      getRegistered,
      mcpToolCallHandler,
      mcpCompletions,
      mcpToolOwners,
      onProblem,
      options.startupWaitMs ?? TWIN_STARTUP_WAIT_MS,
    );
    twin.trackServers(twin.servers, true, mcpRegisteredNamespaces);
    return twin;
  }

  /** Report a non-fatal problem to the host. */
  reportProblem(problem: string): void {
    this.onProblem(problem);
  }

  /** Enabled MCP servers configured for this twin, even while still connecting. */
  mcpServers(): readonly TwinMcpServer[] {
    return this.servers;
  }

  /** Advances whenever a server settles or the server list changes. */
  readinessVersion(): number {
    return this.version;
  }

  /** Call `listener` when MCP tools register, a server settles, or servers change. */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /** Enabled MCP servers that `reach` can touch. */
  matchedServers(reach: McpReach): TwinMcpServer[] {
    if (reach === "all") return [...this.servers];
    if (reach === "indirect")
      return this.servers.filter((server) => server.hasIndirect);
    if (reach.length === 0) return [];
    const activeTools = new Set(
      this.session
        .getAllTools()
        .filter((info) => info.exposure !== "hidden")
        .map((info) => info.name),
    );
    const matched = new Set<string>();
    for (const word of reach) {
      // Exact MCP tool provenance: map directly to its owning MCP server,
      // without falling through to prefix matching.
      const mcpOwner = this.mcpToolOwners.get(word);
      if (mcpOwner !== undefined) {
        matched.add(mcpOwner);
        continue;
      }
      // An active non-MCP tool (such as a shared extension tool placed in an
      // `mcp__*` namespace) belongs to no MCP server.
      if (activeTools.has(word)) continue;
      for (const server of this.servers) {
        if (wordMatchesNamespace(word, server.namespace))
          matched.add(server.namespace);
      }
    }
    return this.servers.filter((server) => matched.has(server.namespace));
  }

  /**
   * Latest startup-wait deadline among servers matching `reach` that are
   * still connecting, or `undefined` when every matched server has settled
   * or passed its wait deadline.
   */
  pendingDeadline(reach: McpReach, now = Date.now()): number | undefined {
    if (this.closed.signal.aborted) return undefined;
    this.pollPrefixOverlaps();
    let deadline: number | undefined;
    for (const server of this.matchedServers(reach)) {
      const entry = this.readiness.get(server.namespace);
      if (!entry || entry.settled || now >= entry.deadline) continue;
      deadline =
        deadline === undefined
          ? entry.deadline
          : Math.max(deadline, entry.deadline);
    }
    return deadline;
  }

  /**
   * Re-evaluate `pendingEntries()` on every twin change (tool registration,
   * server settlement, server add/remove/replace) until no entry remains
   * unsettled, the deadline passes, the twin closes, or `signal` aborts.
   */
  private async waitUntil(
    pendingEntries: () => ServerReadiness[],
    signal?: AbortSignal,
    fixedDeadline?: number,
  ): Promise<void> {
    if (this.closed.signal.aborted || signal?.aborted) return;
    let deadline = fixedDeadline;
    for (;;) {
      if (this.closed.signal.aborted || signal?.aborted) return;
      this.pollPrefixOverlaps();
      const now = Date.now();
      const pending = pendingEntries().filter(
        (entry) => !entry.settled && now < (deadline ?? entry.deadline),
      );
      if (pending.length === 0) return;
      const targetDeadline =
        deadline ?? Math.max(...pending.map((entry) => entry.deadline));
      deadline ??= targetDeadline;
      const remainingMs = targetDeadline - now;
      if (remainingMs <= 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onWake: (() => void) | undefined;
      let unsubscribe: (() => void) | undefined;
      const wake = new Promise<void>((resolve) => {
        onWake = () => resolve();
        timer = setTimeout(onWake, remainingMs);
        timer.unref?.();
        unsubscribe = this.onChange(onWake);
        this.closed.signal.addEventListener("abort", onWake, { once: true });
        signal?.addEventListener("abort", onWake, { once: true });
      });
      try {
        await Promise.race([wake, ...pending.map((entry) => entry.promise)]);
      } finally {
        clearTimeout(timer);
        unsubscribe?.();
        if (onWake) {
          this.closed.signal.removeEventListener("abort", onWake);
          signal?.removeEventListener("abort", onWake);
        }
      }
    }
  }

  /**
   * Wait until every connecting server matching `reach` connects, fails, or
   * reaches its startup wait deadline. Re-evaluates matched servers on changes
   * so newly registered tool ownership drops unrelated prefix siblings at once.
   */
  async waitFor(reach: McpReach, signal?: AbortSignal): Promise<void> {
    await this.waitUntil(() => {
      const entries: ServerReadiness[] = [];
      for (const server of this.matchedServers(reach)) {
        const entry = this.readiness.get(server.namespace);
        if (entry) entries.push(entry);
      }
      return entries;
    }, signal);
  }

  /**
   * Wait for exact MCP server namespaces by ID, without resolving through tool
   * names (so a server whose namespace collides with another server's tool
   * name still waits on the right server).
   */
  async waitForNamespaces(
    namespaces: readonly string[],
    signal?: AbortSignal,
  ): Promise<void> {
    if (namespaces.length === 0) return;
    const unique = [...new Set(namespaces)];
    await this.waitUntil(
      () =>
        unique.flatMap((namespace) => {
          const entry = this.readiness.get(namespace);
          return entry ? [entry] : [];
        }),
      signal,
    );
  }

  /**
   * Wait once for servers with `direct` tools, matching Pi's
   * `before_agent_start`. Concurrent callers share the same in-flight wait,
   * and mid-wait server replacements keep the wait active until the
   * replacement settles or the original startup deadline expires.
   */
  async waitForDirect(signal?: AbortSignal): Promise<void> {
    if (!this.directWait) {
      const hasDirect = this.servers.some((server) => server.hasDirect);
      if (!hasDirect) {
        this.directWait = Promise.resolve();
      } else {
        const deadline = Date.now() + this.startupWaitMs;
        this.directWait = this.waitUntil(
          () =>
            this.servers.flatMap((server) => {
              if (!server.hasDirect) return [];
              const entry = this.readiness.get(server.namespace);
              return entry ? [entry] : [];
            }),
          undefined,
          deadline,
        );
      }
    }
    await abortable(this.directWait, signal);
  }

  private trackServers(
    servers: readonly TwinMcpServer[],
    probeNow: boolean,
    present?: ReadonlySet<string>,
  ): Array<{ name: string; namespace: string; entry: ServerReadiness }> {
    const deadline = Date.now() + this.startupWaitMs;
    const created: Array<{
      name: string;
      namespace: string;
      entry: ServerReadiness;
    }> = [];
    for (const server of servers) {
      if (this.readiness.has(server.namespace)) continue;
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      const alreadyReady = probeNow && present?.has(server.namespace) === true;
      const entry: ServerReadiness = {
        promise,
        resolve,
        deadline,
        settled: alreadyReady,
        awaitingStart: !probeNow && !alreadyReady,
      };
      this.readiness.set(server.namespace, entry);
      if (alreadyReady) {
        resolve();
        continue;
      }
      created.push({ name: server.name, namespace: server.namespace, entry });
      if (probeNow) this.startProbe(server.namespace, entry);
    }
    this.ensurePrefixOverlapTimer();
    return created;
  }

  /**
   * Invoke Pi's MCP `tool_call` handler directly for `READY_TOOL`, bypassing
   * shared extensions' `tool_call` hooks so they cannot block or short-circuit
   * readiness probing.
   */
  private startProbe(namespace: string, entry: ServerReadiness): void {
    if (this.closed.signal.aborted || entry.settled) return;
    const handler = this.mcpToolCallHandler;
    if (!handler) {
      this.markSettledEntry(namespace, entry);
      return;
    }
    const id = this.nextId();
    const ctx = withSignal(
      this.session.extensionRunner.createToolContext(id, this.closed.signal),
      this.closed.signal,
    );
    void Promise.resolve(
      handler(
        {
          type: "tool_call",
          toolName: READY_TOOL,
          toolCallId: id,
          input: { reach: [namespace] },
        },
        ctx,
      ),
    ).then(
      () => this.markSettledEntry(namespace, entry),
      () => this.markSettledEntry(namespace, entry),
    );
  }

  /** Readiness entries matching Pi's `reachesServer()` substring semantics. */
  private matchingSubstringEntries(
    reach: "all" | readonly string[],
  ): ServerReadiness[] {
    const entries: ServerReadiness[] = [];
    for (const server of this.servers) {
      if (
        reach !== "all" &&
        !reach.some((word) => word.includes(server.namespace))
      )
        continue;
      const entry = this.readiness.get(server.namespace);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  /**
   * Pending startup deadline matching Pi's `reachesServer()` substring
   * semantics (`word.includes(namespace)`), used when bounding Pi's MCP
   * `tool_call` wait for shared extension tools that declare `reachesTools`.
   */
  private pendingSubstringDeadline(
    reach: "all" | readonly string[],
    now = Date.now(),
  ): number | undefined {
    if (this.closed.signal.aborted) return undefined;
    this.pollPrefixOverlaps();
    let deadline: number | undefined;
    for (const entry of this.matchingSubstringEntries(reach)) {
      if (entry.settled || now >= entry.deadline) continue;
      deadline =
        deadline === undefined
          ? entry.deadline
          : Math.max(deadline, entry.deadline);
    }
    return deadline;
  }

  /**
   * Bound Pi's MCP `tool_call` readiness wait during real `ToolTwin.call()`
   * invocations: MCP resource tools and shared extension tools declaring
   * `reachesTools` wait at most until the twin's startup budget for their
   * reached servers expires (never applying that timeout to `execute()`), and
   * regular MCP calls honor call cancellation and twin shutdown.
   */
  private async runMcpToolCall(
    event: ToolCallEvent,
    ctx: ExtensionContext,
    handler: ToolCallHandler,
  ): Promise<ToolCallEventResult | undefined> {
    const callSignal = this.activeCallSignals.get(event.toolCallId);
    const tool = this.session
      .getAllTools()
      .find((candidate) => candidate.name === event.toolName);
    const declaredReach = tool?.reachesTools?.(event.input);
    const reach: "all" | readonly string[] | undefined =
      declaredReach !== undefined
        ? declaredReach
        : MCP_RESOURCE_TOOLS.has(event.toolName)
          ? "all"
          : undefined;
    if (reach === undefined) {
      const combined = callSignal
        ? AbortSignal.any([this.closed.signal, callSignal])
        : this.closed.signal;
      return handler(event, withSignal(ctx, combined));
    }
    const deadline = this.pendingSubstringDeadline(reach);
    if (deadline === undefined) {
      return handler(event, withSignal(ctx, AbortSignal.abort()));
    }
    // Wait reactively for all reached servers (including through `awaitingStart`
    // and any mid-wait server replacements) up to `deadline`, then run Pi's
    // handler bounded by whatever budget remains.
    await this.waitUntil(
      () => this.matchingSubstringEntries(reach),
      callSignal,
      deadline,
    );
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0 || this.closed.signal.aborted || callSignal?.aborted) {
      return handler(event, withSignal(ctx, AbortSignal.abort()));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remainingMs);
    timer.unref?.();
    const onAbort = () => controller.abort();
    this.closed.signal.addEventListener("abort", onAbort, { once: true });
    callSignal?.addEventListener("abort", onAbort, { once: true });
    if (this.closed.signal.aborted || callSignal?.aborted) controller.abort();
    try {
      return await handler(event, withSignal(ctx, controller.signal));
    } finally {
      clearTimeout(timer);
      this.closed.signal.removeEventListener("abort", onAbort);
      callSignal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Pi's `reachesServer()` uses substring matching (`word.includes(namespace)`),
   * so probing `mcp__team_mcp__alpha` or `mcp__linear_personal` also waits on
   * a hanging `mcp__alpha` / `mcp__linear`.
   */
  private hasSubstringSibling(server: TwinMcpServer): boolean {
    for (const namespace of this.enabledNamespaces) {
      if (
        namespace !== server.namespace &&
        server.namespace.includes(namespace)
      )
        return true;
    }
    return false;
  }

  /** Current connection state string from Pi's `/mcp reconnect` completion,
   * or `undefined` while the server has no connection object yet. */
  private serverState(name: string): string | undefined {
    const completions = this.mcpCompletions;
    if (!completions) return undefined;
    const items = completions(`reconnect ${name}`);
    const match = Array.isArray(items)
      ? items.find((item) => item.label === name)
      : undefined;
    return match?.description;
  }

  /**
   * For servers whose namespace contains another enabled server's namespace,
   * check Pi's `/mcp reconnect` completion state so an empty or failed server
   * settles without waiting for a hanging substring sibling.
   */
  private pollPrefixOverlaps(): void {
    if (!this.mcpCompletions || this.closed.signal.aborted) return;
    const now = Date.now();
    let anyUnsettledOverlap = false;
    for (const server of this.servers) {
      if (!this.hasSubstringSibling(server)) continue;
      const entry = this.readiness.get(server.namespace);
      if (
        !entry ||
        entry.settled ||
        entry.awaitingStart ||
        now >= entry.deadline
      )
        continue;
      const state = this.serverState(server.name);
      if (state && !state.startsWith("connecting") && state !== "starting") {
        this.markSettledEntry(server.namespace, entry);
      } else {
        anyUnsettledOverlap = true;
      }
    }
    if (!anyUnsettledOverlap && this.prefixTimer) {
      clearInterval(this.prefixTimer);
      this.prefixTimer = undefined;
    }
  }

  private ensurePrefixOverlapTimer(): void {
    if (this.prefixTimer || !this.mcpCompletions || this.closed.signal.aborted)
      return;
    const now = Date.now();
    const needed = this.servers.some((server) => {
      if (!this.hasSubstringSibling(server)) return false;
      const entry = this.readiness.get(server.namespace);
      return (
        entry !== undefined &&
        !entry.settled &&
        !entry.awaitingStart &&
        now < entry.deadline
      );
    });
    if (!needed) return;
    this.prefixTimer = setInterval(
      () => this.pollPrefixOverlaps(),
      PREFIX_OVERLAP_POLL_MS,
    );
    this.prefixTimer.unref?.();
  }

  private refreshServers(event: object): void {
    if (this.closed.signal.aborted) return;
    const previousConfigs = this.registeredConfigs;
    const merged = mergeMcpServers(this.configured, this.getRegistered());
    this.servers = merged.servers;
    this.enabledNamespaces = merged.enabledNamespaces;
    this.registeredConfigs = merged.registeredConfigs;
    const active = new Set(this.servers.map((server) => server.namespace));
    for (const [namespace, entry] of this.readiness) {
      const configChanged =
        merged.registeredConfigs.has(namespace) &&
        previousConfigs.get(namespace) !==
          merged.registeredConfigs.get(namespace);
      if (active.has(namespace) && !configChanged) continue;
      entry.settled = true;
      entry.resolve();
      this.readiness.delete(namespace);
    }
    const created = this.trackServers(this.servers, false);
    this.pendingChangeBatches.set(event, created);
    this.version += 1;
    this.emitChange();
  }

  /**
   * Watch a dynamically registered/replaced server after Pi's
   * `mcp_servers_change` handler has removed any old server entry and begun
   * closing old transports. Once Pi creates the new server's connection
   * (`serverState(name) !== undefined`), `old.close()` has finished and
   * `server.ready` is set, so we hand off to `startProbe()` without waiting
   * for unrelated hanging siblings in the same batch.
   */
  private watchDynamicEntry(
    item: { name: string; namespace: string; entry: ServerReadiness },
    allHandlersDone: Promise<void>,
  ): void {
    const { name, namespace, entry } = item;
    if (!this.mcpCompletions) {
      void allHandlersDone.then(() => {
        if (
          this.closed.signal.aborted ||
          this.readiness.get(namespace) !== entry
        )
          return;
        entry.awaitingStart = false;
        this.startProbe(namespace, entry);
        this.emitChange();
      });
      return;
    }
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      if (!timer) return;
      clearInterval(timer);
      this.watchTimers.delete(timer);
      timer = undefined;
    };
    const check = (): boolean => {
      if (
        this.closed.signal.aborted ||
        entry.settled ||
        this.readiness.get(namespace) !== entry
      ) {
        stop();
        return true;
      }
      const state = this.serverState(name);
      if (state === undefined) return false;
      entry.awaitingStart = false;
      stop();
      if (!state.startsWith("connecting") && state !== "starting") {
        this.markSettledEntry(namespace, entry);
      } else {
        this.startProbe(namespace, entry);
        this.ensurePrefixOverlapTimer();
        // Wake any `waitUntil()` waiting for `awaitingStart` to clear.
        this.emitChange();
      }
      return true;
    };
    timer = setInterval(() => {
      check();
    }, 20);
    timer.unref?.();
    this.watchTimers.add(timer);
    queueMicrotask(() => {
      check();
    });
    void allHandlersDone.then(() => {
      if (
        this.closed.signal.aborted ||
        entry.settled ||
        this.readiness.get(namespace) !== entry
      ) {
        stop();
        return;
      }
      if (check()) return;
      // Every relevant `mcp_servers_change` handler finished without creating
      // a connection (for example disabled or runtime load failure).
      entry.awaitingStart = false;
      stop();
      this.markSettledEntry(namespace, entry);
    });
  }

  private async runServersChange(
    event: object,
    run: () => Promise<void>,
  ): Promise<void> {
    const batch = this.pendingChangeBatches.get(event);
    this.pendingChangeBatches.delete(event);
    const priorChanges = [...this.inFlightChanges];
    // Pi's handler synchronously removes any old server (and its connection)
    // and pushes the new server with `connection: undefined` before awaiting
    // `old.close()`. Starting the watcher right after `run()` begins ensures
    // `serverState()` only ever sees the new server's connection.
    const work = run();
    const done = work.then(
      () => undefined,
      () => undefined,
    );
    this.inFlightChanges.add(done);
    void done.finally(() => this.inFlightChanges.delete(done));
    if (batch && batch.length > 0) {
      const allHandlersDone = Promise.all([done, ...priorChanges]).then(
        () => undefined,
      );
      for (const item of batch) this.watchDynamicEntry(item, allHandlersDone);
    }
    await work;
  }

  private onMcpToolRegistered(tool: AnyDefinition): void {
    if (this.closed.signal.aborted) return;
    // Withdrawing old tools (for example when replacing a server) re-registers
    // them with `exposure: "hidden"`; only non-hidden registrations indicate
    // that the server's active tools are ready.
    if (tool.exposure !== "hidden" && tool.namespace?.name)
      this.registeredNamespaces.add(tool.namespace.name);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    // registerTools() registers a server's tools in one synchronous loop;
    // flush once the loop finishes so callers see the full tool set.
    queueMicrotask(() => {
      this.flushScheduled = false;
      if (this.closed.signal.aborted) return;
      for (const namespace of this.registeredNamespaces) {
        const entry = this.readiness.get(namespace);
        if (entry && !entry.settled) {
          entry.awaitingStart = false;
          entry.settled = true;
          entry.resolve();
          this.version += 1;
        }
      }
      this.registeredNamespaces.clear();
      this.emitChange();
    });
  }

  private markSettledEntry(namespace: string, entry: ServerReadiness): void {
    if (this.closed.signal.aborted) return;
    if (this.readiness.get(namespace) !== entry || entry.settled) return;
    entry.settled = true;
    entry.resolve();
    this.version += 1;
    this.emitChange();
  }

  private emitChange(): void {
    for (const listener of [...this.changeListeners]) listener();
  }

  /** The tools agents can call: MCP's and the allowed extensions'. */
  tools(): TwinTool[] {
    return this.session.getAllTools().flatMap((info) => {
      if (info.sourceInfo.source === "builtin" || info.name === READY_TOOL)
        return [];
      if (info.exposure === "hidden" || info.exposure === "model-only")
        return [];
      const definition = this.session.getToolDefinition(info.name);
      return definition ? [{ info, definition }] : [];
    });
  }

  /**
   * Run a tool as Pi would: its extensions' `tool_call` hooks first, which
   * wait until its MCP server is ready and may block the call, then the
   * tool, then the `tool_result` hooks, which may change its result. The
   * hooks see the twin's context, which knows nothing of the call's
   * cancellation, so the call stops waiting for them once it is aborted.
   */
  async call(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: (partial: TwinResult) => void,
  ): Promise<TwinResult> {
    const runner = this.session.extensionRunner;
    const id = this.nextId();
    this.activeCallSignals.set(id, signal);
    let blocked: Awaited<ReturnType<typeof runner.emitToolCall>>;
    try {
      blocked = await abortable(
        runner.emitToolCall({
          type: "tool_call",
          toolName: name,
          toolCallId: id,
          input: args,
        }),
        signal,
      );
    } finally {
      this.activeCallSignals.delete(id);
    }
    if (blocked?.block)
      throw new Error(blocked.reason ?? `The call of ${name} was blocked`);
    signal?.throwIfAborted();
    // A server can reconnect meanwhile, which registers its tools again.
    const definition = this.session.getToolDefinition(name);
    if (!definition)
      throw new Error(`${name} isn't available: its server isn't connected`);
    const context = runner.createToolContext(id, signal);
    // The tool's `ctx.signal` is the call's, as in Pi.
    Object.defineProperty(context, "signal", {
      get: () => signal,
      configurable: true,
      enumerable: true,
    });
    let result: TwinResult;
    try {
      result = await definition.execute(id, args, signal, onUpdate, context);
    } catch (error) {
      signal?.throwIfAborted();
      // Pi runs the result hooks on failures too.
      result = {
        content: [{ type: "text", text: message(error) }],
        details: {},
        isError: true,
      };
    }
    if (!runner.hasHandlers("tool_result")) return result;
    const hooked = await abortable(
      runner.emitToolResult({
        type: "tool_result",
        toolName: name,
        toolCallId: id,
        input: args,
        content: result.content,
        details: result.details,
        ...(result.structuredContent === undefined
          ? {}
          : { structuredContent: result.structuredContent }),
        isError: result.isError === true,
        usage: result.usage,
      }),
      signal,
    );
    if (!hooked) return result;
    return {
      content: hooked.content ?? result.content,
      details: hooked.details,
      ...(hooked.structuredContent === undefined
        ? {}
        : { structuredContent: hooked.structuredContent }),
      ...(hooked.isError ? { isError: true } : {}),
      ...(hooked.usage ? { usage: hooked.usage } : {}),
    };
  }

  /** Close the twin's connections. */
  async close(): Promise<void> {
    clearInterval(this.prefixTimer);
    this.prefixTimer = undefined;
    for (const timer of this.watchTimers) clearInterval(timer);
    this.watchTimers.clear();
    this.closed.abort();
    this.activeCallSignals.clear();
    this.inFlightChanges.clear();
    this.changeListeners.clear();
    for (const entry of this.readiness.values()) {
      entry.settled = true;
      entry.resolve();
    }
    this.readiness.clear();
    await this.session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
    this.session.dispose();
  }

  private nextId(): string {
    this.counter += 1;
    return `pi-agents-twin-${this.counter}`;
  }
}
