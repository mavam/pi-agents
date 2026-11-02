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
  type ExtensionFactory,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** How long opening waits for servers to connect, as Pi waits at start. */
export const TWIN_STARTUP_WAIT_MS = 10_000;

/** A tool that reaches every tool, so Pi's MCP extension waits for every
 * server before it runs. Hidden: nothing calls it. */
const READY_TOOL = "pi_agents_twin_ready";

// biome-ignore lint/suspicious/noExplicitAny: Pi's tool definitions vary in schema.
type AnyDefinition = ToolDefinition<any, any>;

/** A tool of the twin that agents can call. */
export interface TwinTool {
  info: ToolInfo;
  definition: AnyDefinition;
}

/** What a call returns, as Pi's tools return it. */
export type TwinResult = Awaited<ReturnType<AnyDefinition["execute"]>>;

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
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

/** The twin's own extension: the readiness probe. */
const probe: ExtensionFactory = (pi: ExtensionAPI) => {
  pi.registerTool({
    name: READY_TOOL,
    label: READY_TOOL,
    description: "Waits for every MCP server.",
    parameters: Type.Object({}),
    exposure: "hidden",
    reachesTools: () => "all",
    async execute() {
      return { content: [], details: undefined };
    },
  });
};

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

export class ToolTwin {
  private counter = 0;

  private constructor(
    private readonly session: Awaited<
      ReturnType<typeof createAgentSession>
    >["session"],
  ) {}

  /** Start the twin; its MCP servers connect in the background. */
  static async open(options: ToolTwinOptions): Promise<ToolTwin> {
    const { cwd, onProblem, trusted } = options;
    const agentDir = getAgentDir();
    const paths = await extensionPaths(
      cwd,
      agentDir,
      trusted,
      options.extensions,
      onProblem,
    );
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
      extensionFactories: [createMcpExtension(), probe],
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
    return new ToolTwin(session);
  }

  /**
   * Wait until every MCP server connected or failed, at most `timeoutMs`.
   * Servers that take longer add their tools once they connect.
   */
  async ready(timeoutMs: number): Promise<void> {
    const signal = AbortSignal.timeout(timeoutMs);
    await Promise.race([
      this.session.extensionRunner.emitToolCall({
        type: "tool_call",
        toolName: READY_TOOL,
        toolCallId: this.nextId(),
        input: {},
      }),
      new Promise((resolve) =>
        signal.addEventListener("abort", resolve, { once: true }),
      ),
    ]);
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
    const blocked = await abortable(
      runner.emitToolCall({
        type: "tool_call",
        toolName: name,
        toolCallId: id,
        input: args,
      }),
      signal,
    );
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
