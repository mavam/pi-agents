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
  /** A problem the user should know about; the twin keeps working. */
  onProblem: (message: string) => void;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

/** Extension paths of the installed packages among `sources`. */
async function extensionPaths(
  cwd: string,
  agentDir: string,
  settingsManager: SettingsManager,
  sources: readonly string[],
  onProblem: (message: string) => void,
): Promise<string[]> {
  if (sources.length === 0) return [];
  const packages = new DefaultPackageManager({
    cwd,
    agentDir,
    settingsManager,
  });
  // Only what Pi installed: the twin never installs anything.
  const installed = sources.filter(
    (source) =>
      packages.getInstalledPath(source, "user") !== undefined ||
      packages.getInstalledPath(source, "project") !== undefined,
  );
  for (const source of sources)
    if (!installed.includes(source))
      onProblem(`${source} isn't installed; run pi install ${source}`);
  if (installed.length === 0) return [];
  const resolved = await packages.resolveExtensionSources([...installed]);
  return resolved.extensions
    .filter((resource) => resource.enabled)
    .map((resource) => resource.path);
}

/**
 * Whether a twin would host anything: extensions to load, or an `mcp.json`
 * in Pi's directory or the project. Without them, opening one only costs
 * time.
 */
export function twinWanted(
  cwd: string,
  extensions: readonly string[],
): boolean {
  return (
    extensions.length > 0 ||
    fs.existsSync(path.join(getAgentDir(), "mcp.json")) ||
    fs.existsSync(path.join(cwd, ".pi", "mcp.json"))
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
    const { cwd, onProblem } = options;
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const paths = await extensionPaths(
      cwd,
      agentDir,
      settingsManager,
      options.extensions,
      onProblem,
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
   * tool itself.
   */
  async call(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: (partial: TwinResult) => void,
  ): Promise<TwinResult> {
    const runner = this.session.extensionRunner;
    const id = this.nextId();
    const blocked = await runner.emitToolCall({
      type: "tool_call",
      toolName: name,
      toolCallId: id,
      input: args,
    });
    if (blocked?.block)
      throw new Error(blocked.reason ?? `The call of ${name} was blocked`);
    // A server can reconnect meanwhile, which registers its tools again.
    const definition = this.session.getToolDefinition(name);
    if (!definition)
      throw new Error(`${name} isn't available: its server isn't connected`);
    return definition.execute(
      id,
      args,
      signal,
      onUpdate,
      runner.createToolContext(id, signal),
    );
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
