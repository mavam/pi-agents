import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  getCurrentSystemMessage,
  getCurrentTools,
} from "@earendil-works/pi-ai/utils/transcript";
import { hook, ToolTask } from "@earendil-works/pi-durable";
import { CODEMODE_TOOL_NAME } from "@earendil-works/pi-durable/codemode";
import type { AgentService } from "../../src/agents/service.js";
import { AgentService as AgentServiceClass } from "../../src/agents/service.js";
import { openAgentHarness } from "../../src/host/harness.js";
import { ToolTwin } from "../../src/host/twin.js";
import {
  closeService,
  gate,
  heldUntilAborted,
  hostOf,
  jsonlStorage,
  MODEL,
  openService,
  TestParent,
  tempDir,
  testExtensions,
  until,
} from "../agents/helpers.js";

let services: AgentService[] = [];
let tempDirs: string[] = [];
let savedAgentDir: string | undefined;

function trackedTempDir(prefix = "pi-agents-"): string {
  const dir = tempDir(prefix);
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = trackedTempDir("pi-agents-agentdir-");
});

afterEach(async () => {
  for (const service of services) await closeService(service);
  services = [];
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

/** Write a minimal stdio MCP server script for lazy-startup and resume tests. */
function mcpServerScript(directory: string): string {
  const script = path.join(directory, "mcp-server.mjs");
  fs.writeFileSync(
    script,
    `import * as fs from "node:fs";
import * as readline from "node:readline";

const delayMs = Number(process.env.DELAY_MS ?? "0");
const closeDelayMs = Number(process.env.CLOSE_DELAY_MS ?? "0");
const initHoldFile = process.env.INIT_HOLD_FILE;
const hang = process.env.HANG === "1";
const noTools = process.env.NO_TOOLS === "1";
const hasResources = process.env.RESOURCES === "1";
const toolName = process.env.TOOL_NAME ?? "ping";
const replyText = process.env.REPLY_TEXT ?? "mcp-pong";
const holdFile = process.env.CALL_HOLD_FILE;
const startedFile = process.env.CALL_STARTED_FILE;

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("close", () => {
  if (closeDelayMs > 0) setTimeout(() => process.exit(0), closeDelayMs);
  else process.exit(0);
});
rl.on("line", (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  if (req.id === undefined) return;
  if (req.method === "initialize") {
    if (hang) return;
    const reply = () =>
      send({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: {
            tools: {},
            ...(hasResources ? { resources: {} } : {}),
          },
          serverInfo: { name: "test-mcp", version: "1.0.0" },
        },
      });
    if (initHoldFile) {
      const wait = () => {
        if (!fs.existsSync(initHoldFile)) reply();
        else setTimeout(wait, 10);
      };
      wait();
    } else if (delayMs > 0) {
      setTimeout(reply, delayMs);
    } else {
      reply();
    }
    return;
  }
  if (req.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        tools: noTools
          ? []
          : [
              {
                name: toolName,
                description: "Test ping tool",
                inputSchema: { type: "object", properties: {} },
                annotations: { readOnlyHint: true },
              },
            ],
      },
    });
    return;
  }
  if (req.method === "resources/list") {
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: { resources: [{ uri: "test://doc", name: "doc" }] },
    });
    return;
  }
  if (req.method === "tools/call") {
    if (holdFile && fs.existsSync(holdFile)) {
      if (startedFile) fs.writeFileSync(startedFile, "started");
      return;
    }
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: { content: [{ type: "text", text: replyText }] },
    });
  }
});
`,
  );
  return script;
}

function writeMcpFile(
  filePath: string,
  mcpServers: Record<string, Record<string, unknown>>,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ mcpServers }));
}

function writeProjectMcp(
  cwd: string,
  mcpServers: Record<string, Record<string, unknown>>,
): void {
  writeMcpFile(path.join(cwd, ".pi", "mcp.json"), mcpServers);
}

/** A shared extension whose `tool_call` hook blocks unknown tools, to verify
 * it cannot short-circuit the twin's MCP readiness probing. */
function blockingToolCallPackage(): string {
  const directory = trackedTempDir("pi-agents-blocker-");
  fs.writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({
      name: "twin-blocker",
      pi: { extensions: ["./block.ts"] },
    }),
  );
  fs.writeFileSync(
    path.join(directory, "block.ts"),
    `export default function (pi) {
  pi.on("tool_call", (event) => {
    if (!event.toolName.startsWith("mcp__")) {
      return { block: true, reason: "blocked by shared extension" };
    }
  });
}
`,
  );
  return directory;
}

/** A Pi package whose extension registers `twin_echo`, as Webfox
 * registers its web tools, and `twin_ping` for scripts, as MCP does. */
function echoPackage(): string {
  const directory = trackedTempDir("pi-agents-twin-");
  fs.writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({ name: "twin-echo", pi: { extensions: ["./echo.ts"] } }),
  );
  fs.writeFileSync(
    path.join(directory, "echo.ts"),
    `import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({
    name: "twin_echo",
    label: "Echo",
    description: "Echo the text",
    promptSnippet: "  Echo text\\n  back through the twin  ",
    promptGuidelines: [
      "  Use twin_echo for echo requests  ",
      "Use twin_echo for echo requests",
      "   ",
    ],
    parameters: Type.Object({ text: Type.String() }),
    async execute(_id, params, _signal, onUpdate) {
      onUpdate?.({ content: [{ type: "text", text: "echoing" }], details: {} });
      return { content: [{ type: "text", text: "echo: " + params.text }], details: { length: params.text.length } };
    },
  });
  // Declared only to codemode, as MCP's tools are by default.
  pi.registerTool({
    name: "twin_ping",
    label: "Ping",
    description: "Ping the twin",
    promptSnippet: "Ping the twin service",
    promptGuidelines: ["Only ping when explicitly asked"],
    parameters: Type.Object({}),
    exposure: "codemode",
    namespace: { name: "twin", description: "The twin's tools" },
    async execute() {
      // Schema-less tool returning structuredContent: twin must not forward it.
      return {
        content: [{ type: "text", text: "pong" }],
        details: {},
        structuredContent: { ignored: true },
      };
    },
  });
  // Declares an outputSchema, as MCP and structured Pi extension tools do.
  pi.registerTool({
    name: "twin_data",
    label: "Data",
    description: "Return structured data",
    parameters: Type.Object({ fail: Type.Optional(Type.Boolean()) }),
    outputSchema: Type.Object({
      items: Type.Array(Type.String()),
      count: Type.Number(),
      isError: Type.Optional(Type.Boolean()),
    }),
    exposure: "codemode",
    namespace: { name: "twin", description: "The twin's tools" },
    async execute(_id, params) {
      if (params.fail) {
        return {
          content: [{ type: "text", text: "failed" }],
          details: {},
          isError: true,
          structuredContent: { items: [], count: 0, isError: true },
        };
      }
      return {
        content: [{ type: "text", text: "summary" }],
        details: {},
        structuredContent: { items: ["alpha", "beta"], count: 0 },
      };
    },
  });
}
`,
  );
  return directory;
}

test("agents call the tools of the extensions the twin loads", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(
    Array.from({ length: 4 }, () => (context) => {
      const last = context.messages.at(-1);
      if (last?.role === "toolResult")
        return fauxAssistantMessage(
          last.content
            .map((block) => (block.type === "text" ? block.text : ""))
            .join(""),
        );
      return fauxAssistantMessage([fauxToolCall("twin_echo", { text: "hi" })], {
        stopReason: "toolUse",
      });
    }),
  );
  const problems: string[] = [];
  const service = await openService({
    models,
    twinExtensions: [echoPackage()],
    onTwinProblem: (problem) => problems.push(problem),
  });
  services.push(service);
  // Naming a twin tool is fine: every agent has them all.
  await service.spawnGraph({
    agents: [
      {
        name: "a",
        job: "echo",
        cwd: ".",
        model: MODEL,
        tools: ["read", "twin_echo"],
      },
    ],
  });
  await service.wait(["a"]);
  expect(problems).toEqual([]);
  expect(service.get("a")?.result?.text).toBe("echo: hi");
  expect(service.get("a")?.tools).toEqual(["read"]);
});

test("agents without codemode load the twin's script tools with tool_search", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  // Searches, calls what it loaded, then answers with its result.
  const prompts: string[] = [];
  faux.setResponses(
    Array.from({ length: 4 }, () => (context) => {
      // System messages, with their sections.
      prompts.push(
        JSON.stringify(
          context.messages.filter((message) => message.role === "system"),
        ),
      );
      const last = context.messages.at(-1);
      if (last?.role !== "toolResult")
        return fauxAssistantMessage(
          [fauxToolCall("tool_search", { query: "ping" })],
          { stopReason: "toolUse" },
        );
      if (last.toolName === "tool_search")
        return fauxAssistantMessage([fauxToolCall("twin_ping", {})], {
          stopReason: "toolUse",
        });
      return fauxAssistantMessage(
        last.content
          .map((block) => (block.type === "text" ? block.text : ""))
          .join(""),
      );
    }),
  );
  const service = await openService({
    models,
    twinExtensions: [echoPackage()],
  });
  services.push(service);
  await service.spawnGraph({
    agents: [
      { name: "a", job: "ping", cwd: ".", model: MODEL, tools: ["read"] },
    ],
  });
  await service.wait(["a"]);
  expect(service.get("a")?.result?.text).toBe("pong");
  // The prompt names the namespace and how to reach its tools.
  expect(prompts[0]).toContain("Load their tools with `tool_search`");
  expect(prompts[0]).toContain("- twin: The twin's tools");
});

test("codemode lists the twin's namespaces and describes them", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const prompts: string[] = [];
  faux.setResponses(
    Array.from({ length: 4 }, () => (context) => {
      prompts.push(
        JSON.stringify(
          context.messages.filter((message) => message.role === "system"),
        ),
      );
      const last = context.messages.at(-1);
      if (last?.role === "toolResult")
        return fauxAssistantMessage(
          last.content
            .map((block) => (block.type === "text" ? block.text : ""))
            .join(""),
        );
      return fauxAssistantMessage(
        [
          fauxToolCall("codemode", {
            code: 'return await describeNamespace("twin")',
          }),
        ],
        { stopReason: "toolUse" },
      );
    }),
  );
  const service = await openService({
    models,
    twinExtensions: [echoPackage()],
  });
  services.push(service);
  await service.spawnGraph({
    agents: [
      {
        name: "a",
        job: "describe",
        cwd: ".",
        model: MODEL,
        tools: ["codemode"],
      },
    ],
  });
  await service.wait(["a"]);
  const result = service.get("a")?.result?.text ?? "";
  expect(result).toContain("The twin's tools");
  expect(result).toContain("twin_ping");
  expect(prompts[0]).toContain("## twin");
});

test("codemode scripts see a twin tool's output schema and structured output", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(
    Array.from({ length: 4 }, () => (context) => {
      const last = context.messages.at(-1);
      if (last?.role === "toolResult")
        return fauxAssistantMessage(
          last.content
            .map((block) => (block.type === "text" ? block.text : ""))
            .join(""),
        );
      return fauxAssistantMessage(
        [
          fauxToolCall("codemode", {
            code: `
              const schema = await describeTool("twin_data");
              const ok = await tools.twin_data({});
              const err = await tools.twin_data({ fail: true });
              const ping = await tools.twin_ping({});
              return JSON.stringify({ schema, ok, err, ping });
            `,
          }),
        ],
        { stopReason: "toolUse" },
      );
    }),
  );
  const service = await openService({
    models,
    twinExtensions: [echoPackage()],
  });
  services.push(service);
  await service.spawnGraph({
    agents: [
      {
        name: "a",
        job: "structured",
        cwd: ".",
        model: MODEL,
        tools: ["codemode"],
      },
    ],
  });
  await service.wait(["a"]);
  const text = service.get("a")?.result?.text ?? "";
  const line = text.split("\n").find((entry) => entry.startsWith("{")) ?? "";
  const payload = JSON.parse(line) as {
    schema: string;
    ok: unknown;
    err: unknown;
    ping: unknown;
  };
  expect(payload.schema).toContain("items: Array<string>");
  expect(payload.schema).toContain("count: number");
  expect(payload.ok).toEqual({ items: ["alpha", "beta"], count: 0 });
  expect(payload.err).toEqual({ items: [], count: 0, isError: true });
  expect(payload.ping).toBe("pong");
});

test("direct twin tools contribute prompt snippets and guidelines; deferred tools stay out until loaded", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const snapshots: Array<Record<string, string | null>> = [];
  faux.setResponses(
    Array.from({ length: 4 }, () => (context) => {
      snapshots.push(getCurrentSystemMessage(context.messages)?.sections ?? {});
      const last = context.messages.at(-1);
      if (last?.role !== "toolResult")
        return fauxAssistantMessage(
          [fauxToolCall("tool_search", { query: "ping" })],
          { stopReason: "toolUse" },
        );
      return fauxAssistantMessage("done");
    }),
  );
  const service = await openService({
    models,
    twinExtensions: [echoPackage()],
  });
  services.push(service);
  await service.spawnGraph({
    agents: [
      {
        name: "a",
        job: "check prompt",
        cwd: ".",
        model: MODEL,
        tools: ["read"],
      },
    ],
  });
  await service.wait(["a"]);

  const initial = snapshots[0];
  expect(initial?.tools).toContain(
    "- twin_echo: Echo text back through the twin",
  );
  expect(
    initial?.rules?.match(/Use twin_echo for echo requests/g),
  ).toHaveLength(1);
  expect(initial?.tools).not.toContain("twin_ping");
  expect(initial?.tools).not.toContain("Ping the twin service");
  expect(initial?.rules).not.toContain("Only ping when explicitly asked");

  const afterLoad = snapshots[1];
  expect(afterLoad?.tools).toContain("- twin_ping: Ping the twin service");
  expect(afterLoad?.rules).toContain("- Only ping when explicitly asked");
});

test("malformed prompt metadata does not crash startup and shadowed names do not inherit built-in prompt text", async () => {
  const directory = trackedTempDir("pi-agents-twin-edge-");
  fs.writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({ name: "twin-edge", pi: { extensions: ["./edge.ts"] } }),
  );
  fs.writeFileSync(
    path.join(directory, "edge.ts"),
    `import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({
    name: "twin_malformed",
    label: "Malformed",
    description: "Has non-string promptSnippet and false promptGuidelines",
    promptSnippet: false,
    promptGuidelines: false,
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "ok" }], details: {} };
    },
  });
  pi.registerTool({
    name: "twin_bad_guidelines",
    label: "Bad guidelines",
    description: "Has non-array promptGuidelines",
    promptSnippet: "Keep valid snippet",
    promptGuidelines: "not-an-array",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "ok" }], details: {} };
    },
  });
  pi.registerTool({
    name: "agent_spawn",
    label: "Custom spawn",
    description: "Shadows spawning tool name without prompt metadata",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "custom" }], details: {} };
    },
  });
  pi.registerTool({
    name: "toString",
    label: "Prototype name",
    description: "Named after an Object.prototype key",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "ok" }], details: {} };
    },
  });
}
`,
  );

  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const problems: string[] = [];
  let sections: Record<string, string | null> | undefined;
  faux.setResponses(
    Array.from({ length: 4 }, () => (context) => {
      sections ??= getCurrentSystemMessage(context.messages)?.sections;
      const last = context.messages.at(-1);
      if (last?.role === "toolResult")
        return fauxAssistantMessage(
          last.content
            .map((block) => (block.type === "text" ? block.text : ""))
            .join(""),
        );
      return fauxAssistantMessage([fauxToolCall("twin_malformed", {})], {
        stopReason: "toolUse",
      });
    }),
  );
  const service = await openService({
    models,
    twinExtensions: [directory],
    onTwinProblem: (problem) => problems.push(problem),
  });
  services.push(service);
  await service.spawnGraph({
    agents: [
      { name: "a", job: "edge", cwd: ".", model: MODEL, tools: ["read"] },
    ],
  });
  await service.wait(["a"]);

  expect(problems).toEqual([]);
  expect(service.get("a")?.result?.text).toBe("ok");
  expect(sections?.tools).toContain(
    "- twin_bad_guidelines: Keep valid snippet",
  );
  expect(sections?.tools).not.toContain("twin_malformed");
  expect(sections?.tools).not.toContain("agent_spawn");
  expect(sections?.tools).not.toContain("toString");
  expect(sections?.rules).not.toContain("\n- n\n");
  expect(sections?.rules).not.toContain("Use agent_spawn when");
});

test("shared extensions that override built-in tools follow the allowlist across prompts and helper spawns", async () => {
  const directory = trackedTempDir("pi-agents-twin-override-");
  fs.writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({
      name: "twin-override",
      pi: { extensions: ["./override.ts"] },
    }),
  );
  fs.writeFileSync(
    path.join(directory, "override.ts"),
    `import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({
    name: "read",
    label: "Hashline Read",
    description: "Read files with hashline anchors",
    promptSnippet: "Read file contents with hashline anchors",
    promptGuidelines: ["Use hashline anchors returned by read"],
    parameters: Type.Object({ path: Type.String() }),
    async execute(_id, args) {
      return { content: [{ type: "text", text: \`hashline-read:\${args.path}\` }], details: {} };
    },
  });
  pi.registerTool({
    name: "grep",
    label: "Hashline Grep",
    description: "Search files with hashline anchors",
    promptSnippet: "Search file contents with hashline anchors",
    parameters: Type.Object({ pattern: Type.String() }),
    async execute(_id, args) {
      return { content: [{ type: "text", text: \`hashline-grep:\${args.pattern}\` }], details: {} };
    },
  });
  pi.registerTool({
    name: "outline",
    label: "Outline",
    description: "Show file symbols",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "outline-ok" }], details: {} };
    },
  });
}
`,
  );

  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const seen = new Map<
    string,
    {
      tools: string[];
      sections: Record<string, string | null> | undefined;
    }
  >();
  let helperStep = 0;
  faux.setResponses(
    Array.from({ length: 12 }, () => (context) => {
      const firstUser = context.messages.find((m) => m.role === "user");
      const job =
        firstUser && typeof firstUser.content === "string"
          ? firstUser.content
          : Array.isArray(firstUser?.content)
            ? firstUser.content
                .map((block) => (block.type === "text" ? block.text : ""))
                .join("")
            : "";
      const key = job.split("\n", 1)[0] ?? "";
      if (!seen.has(key)) {
        seen.set(key, {
          tools: getCurrentTools(context.messages).map((tool) => tool.name),
          sections: getCurrentSystemMessage(context.messages)?.sections,
        });
      }
      const last = context.messages.at(-1);
      if (key === "lead-job") {
        if (last?.role === "user") {
          helperStep += 1;
          if (helperStep === 1) {
            return fauxAssistantMessage(
              [fauxToolCall("read", { path: "a.ts" })],
              { stopReason: "toolUse" },
            );
          }
          const lastText =
            typeof last.content === "string"
              ? last.content
              : last.content
                  .map((block) => (block.type === "text" ? block.text : ""))
                  .join("");
          return fauxAssistantMessage(
            `lead-done:${lastText.includes("helper-read:hashline-read:b.ts")}`,
          );
        }
        if (last?.role === "toolResult") {
          const text = last.content
            .map((block) => (block.type === "text" ? block.text : ""))
            .join("");
          if (text === "hashline-read:a.ts") {
            return fauxAssistantMessage(
              [
                fauxToolCall("agent_spawn", {
                  agents: [
                    { name: "escalate", job: "denied", tools: ["grep"] },
                  ],
                }),
              ],
              { stopReason: "toolUse" },
            );
          }
          if (text.includes("asks for tools you don't have: grep")) {
            return fauxAssistantMessage(
              [
                fauxToolCall("agent_spawn", {
                  agents: [
                    { name: "child", job: "helper-job", tools: ["read"] },
                  ],
                }),
              ],
              { stopReason: "toolUse" },
            );
          }
          return fauxAssistantMessage("waiting for helper");
        }
      }
      if (key === "helper-job") {
        if (last?.role === "toolResult") {
          const text = last.content
            .map((block) => (block.type === "text" ? block.text : ""))
            .join("");
          return fauxAssistantMessage(`helper-read:${text}`);
        }
        return fauxAssistantMessage([fauxToolCall("read", { path: "b.ts" })], {
          stopReason: "toolUse",
        });
      }
      if (key === "search-job") {
        if (last?.role === "toolResult") {
          const text = last.content
            .map((block) => (block.type === "text" ? block.text : ""))
            .join("");
          return fauxAssistantMessage(text);
        }
        return fauxAssistantMessage(
          [fauxToolCall("grep", { pattern: "needle" })],
          { stopReason: "toolUse" },
        );
      }
      return fauxAssistantMessage("done");
    }),
  );

  const service = await openService({
    models,
    twinExtensions: [directory],
    skills: async () => [
      {
        name: "demo",
        description: "Demo skill",
        filePath: "/tmp/demo/SKILL.md",
        baseDir: "/tmp/demo",
        sourceInfo: {
          path: "/tmp/demo/SKILL.md",
          source: "user",
          scope: "user",
          origin: "top-level",
        },
        disableModelInvocation: false,
      },
    ],
  });
  services.push(service);

  await service.spawnGraph({
    agents: [
      {
        name: "lead",
        job: "lead-job",
        cwd: ".",
        model: MODEL,
        tools: ["read"],
        spawn: true,
        ambientSkills: true,
      },
    ],
  });
  await service.wait(["lead"]);

  const lead = seen.get("lead-job");
  expect(lead?.tools).toContain("read");
  expect(lead?.tools).toContain("outline");
  expect(lead?.tools).not.toContain("grep");
  expect(lead?.sections?.tools).toContain(
    "- read: Read file contents with hashline anchors",
  );
  expect(lead?.sections?.rules).toContain(
    "- Use hashline anchors returned by read",
  );
  expect(lead?.sections?.skills).toContain("demo");
  expect(lead?.sections?.skills).toContain("read tool");
  expect(service.get("lead")?.result?.text).toBe("lead-done:true");
  const helper = seen.get("helper-job");
  expect(helper?.tools).toContain("read");
  expect(helper?.tools).not.toContain("grep");

  await service.spawnGraph({
    agents: [
      {
        name: "searcher",
        job: "search-job",
        cwd: ".",
        model: MODEL,
        tools: ["read", "grep", "bash"],
      },
    ],
  });
  await service.wait(["searcher"]);

  const searcher = seen.get("search-job");
  expect(searcher?.tools).toEqual(
    expect.arrayContaining(["read", "grep", "bash", "outline"]),
  );
  expect(searcher?.sections?.rules).not.toContain(
    "Use bash for file operations like ls, rg, find",
  );
  expect(service.get("searcher")?.result?.text).toBe("hashline-grep:needle");
});

test("a hanging MCP server does not block harness open or unrelated calls, shows on turn 1, and rejects invalid config overrides", async () => {
  const cwd = trackedTempDir("pi-agents-mcp-cwd-");
  const script = mcpServerScript(cwd);
  // Global server with an invalid project override: Pi rejects the override
  // and keeps the valid global server enabled.
  writeMcpFile(path.join(process.env.PI_CODING_AGENT_DIR ?? "", "mcp.json"), {
    kept: {
      command: process.execPath,
      args: [script],
      env: { HANG: "1" },
      description: "Kept global server",
    },
  });
  writeProjectMcp(cwd, {
    hanging: {
      command: process.execPath,
      args: [script],
      env: { HANG: "1" },
      description: "Hanging MCP server",
    },
    kept: {
      enabled: false,
      exposure: "bogus",
    },
    invalid_url: {
      url: "not-a-valid-url",
      description: "Phantom server",
    },
  });
  const prompts = new Map<string, string>();
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(
    Array.from({ length: 8 }, () => (context) => {
      const system = JSON.stringify(
        context.messages.filter((message) => message.role === "system"),
      );
      const user = context.messages.find((message) => message.role === "user");
      const job =
        typeof user?.content === "string"
          ? user.content
          : (user?.content
              .flatMap((block) => (block.type === "text" ? [block.text] : []))
              .join("") ?? "");
      if (!prompts.has(job)) prompts.set(job, system);
      const last = context.messages.at(-1);
      if (last?.role === "toolResult")
        return fauxAssistantMessage(
          last.content
            .map((block) => (block.type === "text" ? block.text : ""))
            .join(""),
        );
      if (job === "run-codemode")
        return fauxAssistantMessage(
          [fauxToolCall("codemode", { code: 'return "no-mcp-needed"' })],
          { stopReason: "toolUse" },
        );
      return fauxAssistantMessage("answered");
    }),
  );
  const service = await openService({
    cwd,
    trusted: true,
    twin: true,
    twinStartupWaitMs: 30_000,
    models,
  });
  services.push(service);

  await service.spawnGraph({
    agents: [
      {
        name: "a",
        job: "run-codemode",
        cwd,
        model: MODEL,
        tools: ["codemode"],
      },
      { name: "b", job: "no-codemode", cwd, model: MODEL, tools: ["read"] },
    ],
  });
  await service.wait(["a", "b"]);
  expect(service.get("a")?.result?.text).toContain("no-mcp-needed");
  expect(service.get("b")?.result?.text).toBe("answered");
  expect(prompts.get("run-codemode")).toContain("## mcp__hanging");
  expect(prompts.get("run-codemode")).toContain("Hanging MCP server");
  expect(prompts.get("run-codemode")).toContain("## mcp__kept");
  expect(prompts.get("run-codemode")).not.toContain("mcp__invalid_url");
  expect(prompts.get("no-codemode")).toContain(
    "- mcp__hanging: Hanging MCP server",
  );
});

test("codemode waits for reached servers (even across stale snapshots and blocking extensions) and concurrent direct spawns see turn-1 tools", async () => {
  const cwd = trackedTempDir("pi-agents-mcp-lazy-");
  const script = mcpServerScript(cwd);
  const delayedGate = path.join(cwd, "delayed.hold");
  const directGate = path.join(cwd, "direct.hold");
  fs.writeFileSync(delayedGate, "1");
  fs.writeFileSync(directGate, "1");
  writeProjectMcp(cwd, {
    hanging: {
      command: process.execPath,
      args: [script],
      env: { HANG: "1" },
      description: "Never connects",
    },
    delayed: {
      command: process.execPath,
      args: [script],
      env: { INIT_HOLD_FILE: delayedGate, REPLY_TEXT: "delayed-pong" },
      description: "Delayed codemode server",
    },
    direct_srv: {
      command: process.execPath,
      args: [script],
      env: {
        INIT_HOLD_FILE: directGate,
        TOOL_NAME: "greet",
        REPLY_TEXT: "direct-hi",
      },
      exposure: "direct",
      description: "Direct server",
    },
  });
  // Hold an earlier beforeTool hook on the first codemode call until `delayed`
  // connects and syncs, exercising stale-snapshot recovery before twin's gate.
  const hookEntered = gate();
  const hookRelease = gate();
  let heldOnce = false;
  const firstTurnTools = new Map<string, string[]>();
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(
    Array.from({ length: 12 }, () => (context) => {
      const user = context.messages.find((message) => message.role === "user");
      const job =
        typeof user?.content === "string"
          ? user.content
          : (user?.content
              .flatMap((block) => (block.type === "text" ? [block.text] : []))
              .join("") ?? "");
      if (!firstTurnTools.has(job))
        firstTurnTools.set(
          job,
          getCurrentTools(context.messages).map((tool) => tool.name),
        );
      const last = context.messages.at(-1);
      if (last?.role === "toolResult")
        return fauxAssistantMessage(
          last.content
            .map((block) => (block.type === "text" ? block.text : ""))
            .join(""),
        );
      if (job === "call-codemode")
        return fauxAssistantMessage(
          [
            fauxToolCall("codemode", {
              code: "return await tools.mcp__delayed__ping({})",
            }),
          ],
          { stopReason: "toolUse" },
        );
      return fauxAssistantMessage(
        [fauxToolCall("mcp__direct_srv__greet", {})],
        { stopReason: "toolUse" },
      );
    }),
  );
  const service = await openService({
    cwd,
    trusted: true,
    twin: true,
    twinExtensions: [blockingToolCallPackage()],
    twinStartupWaitMs: 30_000,
    taskHooks: [
      hook(ToolTask, {
        beforeTool: async (call) => {
          if (call.name === "codemode" && !heldOnce) {
            heldOnce = true;
            hookEntered.release();
            await hookRelease.promise;
          }
          return undefined;
        },
      }),
    ],
    models,
  });
  services.push(service);

  // Two concurrent spawns must both wait on the same direct-server barrier.
  const spawns = Promise.all([
    service.spawnGraph({
      agents: [
        {
          name: "d1",
          job: "call-direct-1",
          cwd,
          model: MODEL,
          tools: ["read"],
        },
      ],
    }),
    service.spawnGraph({
      agents: [
        {
          name: "d2",
          job: "call-direct-2",
          cwd,
          model: MODEL,
          tools: ["read"],
        },
      ],
    }),
  ]);
  // Release direct_srv while both spawns are concurrently awaiting waitForDirect.
  fs.rmSync(directGate, { force: true });
  await spawns;
  await service.wait(["d1", "d2"]);
  expect(firstTurnTools.get("call-direct-1")).toContain(
    "mcp__direct_srv__greet",
  );
  expect(firstTurnTools.get("call-direct-2")).toContain(
    "mcp__direct_srv__greet",
  );
  expect(service.get("d1")?.result?.text).toBe("direct-hi");
  expect(service.get("d2")?.result?.text).toBe("direct-hi");

  // Spawn codemode agent while `delayed` is still held behind delayedGate.
  await service.spawnGraph({
    agents: [
      {
        name: "cm",
        job: "call-codemode",
        cwd,
        model: MODEL,
        tools: ["codemode"],
      },
    ],
  });
  await hookEntered.promise;
  // Release `delayed` and wait until its tool is synced into the registry
  // BEFORE twin's beforeTool runs on the older phase snapshot.
  fs.rmSync(delayedGate, { force: true });
  await until(() =>
    hostOf(service).extensions.twin.names().includes("mcp__delayed__ping"),
  );
  hookRelease.release();
  await service.wait(["cm"]);
  expect(service.get("cm")?.result?.text).toContain("delayed-pong");
});

test("resumed codemode scripts with computed tool names wait lazily only for the server they call even when list_mcp_resources was offered", async () => {
  const cwd = trackedTempDir("pi-agents-mcp-resume-");
  const storageDir = trackedTempDir("pi-agents-mcp-storage-");
  const script = mcpServerScript(cwd);
  const sampleFile = path.join(cwd, "sample.txt");
  fs.writeFileSync(sampleFile, "hello");
  writeProjectMcp(cwd, {
    hanging: {
      command: process.execPath,
      args: [script],
      env: { HANG: "1" },
    },
    slow: {
      command: process.execPath,
      args: [script],
      env: {
        DELAY_MS: "150",
        RESOURCES: "1",
        REPLY_TEXT: "resumed-pong",
      },
    },
  });
  const makeModels = () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses(
      Array.from({ length: 6 }, () => (context) => {
        const last = context.messages.at(-1);
        if (last?.role === "toolResult")
          return fauxAssistantMessage(
            last.content
              .map((block) => (block.type === "text" ? block.text : ""))
              .join(""),
          );
        // Suspend inside `read` BEFORE the computed MCP call is ever admitted,
        // so reopening genuinely exercises `pi.codemode.run` without a nested MCP task.
        return fauxAssistantMessage(
          [
            fauxToolCall("codemode", {
              code: `await tools.read({ path: ${JSON.stringify(sampleFile)} });
const name = ["mcp", "slow", "ping"].join("__");
return await tools[name]({});`,
            }),
          ],
          { stopReason: "toolUse" },
        );
      }),
    );
    return models;
  };

  const readEntered = gate();
  const before = await openService({
    cwd,
    trusted: true,
    twin: true,
    twinStartupWaitMs: 30_000,
    storage: await jsonlStorage(storageDir),
    taskHooks: [
      hook(ToolTask, {
        beforeTool: async (call, _api, context) => {
          if (call.name === "read") {
            readEntered.release();
            await heldUntilAborted(context.abortSignal);
          }
          return undefined;
        },
      }),
    ],
    models: makeModels(),
  });
  services.push(before);
  // Wait for `slow` (and `list_mcp_resources`) to register in Session 1 before
  // starting the script so both are recorded in `pi.codemode.run`.
  await until(
    () =>
      hostOf(before).extensions.twin.names().includes("mcp__slow__ping") &&
      hostOf(before).extensions.twin.names().includes("list_mcp_resources"),
  );
  await before.spawnGraph({
    agents: [
      {
        name: "a",
        job: "call-slow",
        cwd,
        model: MODEL,
        tools: ["read", "codemode"],
      },
    ],
  });
  await readEntered.promise;
  await closeService(before);
  services = services.filter((service) => service !== before);

  // Reopen with a 30s startupWaitMs: `list_mcp_resources` in `run.start.tools`
  // must NOT trigger waiting on `hanging`, while `mcp__slow` in
  // `run.start.namespaces` IS awaited so the computed call succeeds.
  const after = await openService({
    cwd,
    trusted: true,
    twin: true,
    twinStartupWaitMs: 30_000,
    storage: await jsonlStorage(storageDir),
    models: makeModels(),
  });
  services.push(after);
  await after.wait(["a"]);
  expect(after.get("a")?.result?.text).toContain("resumed-pong");
});

test("substring-overlapping empty servers settle independently even against a hidden hanging sibling", async () => {
  const cwd = trackedTempDir("pi-agents-mcp-prefix-");
  const script = mcpServerScript(cwd);
  writeProjectMcp(cwd, {
    alpha: {
      command: process.execPath,
      args: [script],
      env: { HANG: "1" },
      exposure: "hidden",
    },
    team_mcp__alpha: {
      command: process.execPath,
      args: [script],
      env: { NO_TOOLS: "1" },
    },
  });
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(
    Array.from({ length: 4 }, () => (context) => {
      const last = context.messages.at(-1);
      if (last?.role === "toolResult")
        return fauxAssistantMessage(
          last.content
            .map((block) => (block.type === "text" ? block.text : ""))
            .join(""),
        );
      return fauxAssistantMessage(
        [
          fauxToolCall("codemode", {
            code: 'return "mcp__team_mcp__alpha__ping" in tools ? "unexpected" : "empty-ready";',
          }),
        ],
        { stopReason: "toolUse" },
      );
    }),
  );
  // 30s startupWaitMs: `mcp__team_mcp__alpha` contains `mcp__alpha` as a
  // non-prefix substring; if it waited on hidden hanging `alpha`, this test
  // would time out instead of finishing in milliseconds.
  const service = await openService({
    cwd,
    trusted: true,
    twin: true,
    twinStartupWaitMs: 30_000,
    models,
  });
  services.push(service);
  await service.spawnGraph({
    agents: [
      {
        name: "a",
        job: "check-substring",
        cwd,
        model: MODEL,
        tools: ["codemode"],
      },
    ],
  });
  await service.wait(["a"]);
  expect(service.get("a")?.result?.text).toContain("empty-ready");
});

test("MCP resource tools in codemode stay bounded by startupWaitMs despite a hanging sibling", async () => {
  const cwd = trackedTempDir("pi-agents-mcp-resources-");
  const script = mcpServerScript(cwd);
  writeProjectMcp(cwd, {
    hanging: {
      command: process.execPath,
      args: [script],
      env: { HANG: "1" },
    },
    docs: {
      command: process.execPath,
      args: [script],
      env: { RESOURCES: "1", REPLY_TEXT: "docs-ok" },
    },
  });
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(
    Array.from({ length: 4 }, () => (context) => {
      const last = context.messages.at(-1);
      if (last?.role === "toolResult")
        return fauxAssistantMessage(
          last.content
            .map((block) => (block.type === "text" ? block.text : ""))
            .join(""),
        );
      return fauxAssistantMessage(
        [
          fauxToolCall("codemode", {
            code: "return JSON.stringify(await tools.list_mcp_resources({}));",
          }),
        ],
        { stopReason: "toolUse" },
      );
    }),
  );
  const service = await openService({
    cwd,
    trusted: true,
    twin: true,
    twinStartupWaitMs: 400,
    models,
  });
  services.push(service);
  await service.spawnGraph({
    agents: [
      {
        name: "a",
        job: "list-resources",
        cwd,
        model: MODEL,
        tools: ["codemode"],
      },
    ],
  });
  await service.wait(["a"]);
  expect(service.get("a")?.result?.text).toContain("test://doc");
});

test("shared tool_search does not break deferred MCP discovery and reports the collision", async () => {
  const cwd = trackedTempDir("pi-agents-mcp-search-collide-");
  const script = mcpServerScript(cwd);
  const pkg = trackedTempDir("pi-agents-custom-search-");
  fs.writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify({ name: "custom-search", pi: { extensions: ["./ext.ts"] } }),
  );
  fs.writeFileSync(
    path.join(pkg, "ext.ts"),
    `import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({
    name: "tool_search",
    label: "Custom Search",
    description: "Custom tool_search from shared extension",
    parameters: Type.Object({ query: Type.String() }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: "custom:" + params.query }], details: {} };
    },
  });
}
`,
  );
  writeProjectMcp(cwd, {
    docs: {
      command: process.execPath,
      args: [script],
      env: { DELAY_MS: "100", REPLY_TEXT: "mcp-discovered" },
    },
  });
  const problems: string[] = [];
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(
    Array.from({ length: 6 }, () => (context) => {
      const last = context.messages.at(-1);
      if (last?.role !== "toolResult")
        return fauxAssistantMessage(
          [fauxToolCall("tool_search", { query: "ping" })],
          { stopReason: "toolUse" },
        );
      if (last.toolName === "tool_search")
        return fauxAssistantMessage([fauxToolCall("mcp__docs__ping", {})], {
          stopReason: "toolUse",
        });
      return fauxAssistantMessage(
        last.content
          .map((block) => (block.type === "text" ? block.text : ""))
          .join(""),
      );
    }),
  );
  const service = await openService({
    cwd,
    trusted: true,
    twinExtensions: [pkg],
    twinStartupWaitMs: 30_000,
    onTwinProblem: (problem) => problems.push(problem),
    models,
  });
  services.push(service);
  await service.spawnGraph({
    agents: [
      { name: "a", job: "find-mcp", cwd, model: MODEL, tools: ["read"] },
    ],
  });
  await service.wait(["a"]);
  expect(service.get("a")?.result?.text).toBe("mcp-discovered");
  expect(problems.some((problem) => problem.includes("tool_search"))).toBe(
    true,
  );
});

test("out-of-order dynamic MCP registrations (both slow-then-fast and fast-then-late) and replacement do not settle early", async () => {
  const cwd = trackedTempDir("pi-agents-mcp-dynamic-");
  const script = mcpServerScript(cwd);
  const slowGate = path.join(cwd, "slow_dyn.hold");
  const lateGate = path.join(cwd, "late_dyn.hold");
  const replaceGate = path.join(cwd, "replace_dyn.hold");
  fs.writeFileSync(slowGate, "1");
  fs.writeFileSync(lateGate, "1");
  fs.writeFileSync(replaceGate, "1");
  const pkg = trackedTempDir("pi-agents-dyn-ext-");
  fs.writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify({ name: "dyn-mcp", pi: { extensions: ["./ext.ts"] } }),
  );
  fs.writeFileSync(
    path.join(pkg, "ext.ts"),
    `import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({
    name: "register_slow_fast",
    label: "Register Slow Fast",
    description: "Register slow_dyn then fast_dyn dynamically",
    parameters: Type.Object({}),
    async execute() {
      pi.registerMcpServer("slow_dyn", {
        command: ${JSON.stringify(process.execPath)},
        args: [${JSON.stringify(script)}],
        env: { INIT_HOLD_FILE: ${JSON.stringify(slowGate)}, REPLY_TEXT: "slow-dyn-ok" },
      });
      pi.registerMcpServer("fast_dyn", {
        command: ${JSON.stringify(process.execPath)},
        args: [${JSON.stringify(script)}],
        env: { REPLY_TEXT: "fast-v1" },
      });
      return { content: [{ type: "text", text: "registered-sf" }], details: {} };
    },
  });
  pi.registerTool({
    name: "register_fast_late",
    label: "Register Fast Late",
    description: "Register fast2_dyn then late_dyn synchronously",
    parameters: Type.Object({}),
    async execute() {
      pi.registerMcpServer("fast2_dyn", {
        command: ${JSON.stringify(process.execPath)},
        args: [${JSON.stringify(script)}],
        env: { REPLY_TEXT: "fast2-ok" },
      });
      pi.registerMcpServer("late_dyn", {
        command: ${JSON.stringify(process.execPath)},
        args: [${JSON.stringify(script)}],
        env: { INIT_HOLD_FILE: ${JSON.stringify(lateGate)}, REPLY_TEXT: "late-dyn-ok" },
      });
      return { content: [{ type: "text", text: "registered-fl" }], details: {} };
    },
  });
  pi.registerTool({
    name: "replace_fast",
    label: "Replace Fast",
    description: "Replace fast_dyn with a gated server exposing v2",
    parameters: Type.Object({}),
    async execute() {
      pi.unregisterMcpServer("fast_dyn");
      pi.registerMcpServer("fast_dyn", {
        command: ${JSON.stringify(process.execPath)},
        args: [${JSON.stringify(script)}],
        env: { INIT_HOLD_FILE: ${JSON.stringify(replaceGate)}, TOOL_NAME: "ping2", REPLY_TEXT: "fast-v2" },
      });
      return { content: [{ type: "text", text: "replaced" }], details: {} };
    },
  });
}
`,
  );
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  let turn = 0;
  faux.setResponses(
    Array.from({ length: 12 }, () => (context) => {
      turn += 1;
      if (turn === 1)
        return fauxAssistantMessage([fauxToolCall("register_slow_fast", {})], {
          stopReason: "toolUse",
        });
      if (turn === 2)
        return fauxAssistantMessage(
          [
            fauxToolCall("codemode", {
              code: "return await tools.mcp__slow_dyn__ping({})",
            }),
          ],
          { stopReason: "toolUse" },
        );
      if (turn === 3)
        return fauxAssistantMessage([fauxToolCall("register_fast_late", {})], {
          stopReason: "toolUse",
        });
      if (turn === 4)
        return fauxAssistantMessage(
          [
            fauxToolCall("codemode", {
              code: "return await tools.mcp__late_dyn__ping({})",
            }),
          ],
          { stopReason: "toolUse" },
        );
      if (turn === 5)
        return fauxAssistantMessage([fauxToolCall("replace_fast", {})], {
          stopReason: "toolUse",
        });
      if (turn === 6)
        return fauxAssistantMessage(
          [
            fauxToolCall("codemode", {
              code: "return await tools.mcp__fast_dyn__ping2({})",
            }),
          ],
          { stopReason: "toolUse" },
        );
      const outputs = context.messages
        .filter((message) => message.role === "toolResult")
        .map((message) =>
          message.content
            .map((block) => (block.type === "text" ? block.text : ""))
            .join(""),
        )
        .join("|");
      return fauxAssistantMessage(outputs);
    }),
  );
  const service = await openService({
    cwd,
    trusted: true,
    twinExtensions: [pkg],
    twinStartupWaitMs: 30_000,
    models,
  });
  services.push(service);
  await service.spawnGraph({
    agents: [{ name: "a", job: "dyn", cwd, model: MODEL, tools: ["codemode"] }],
  });
  // Case 1 (slow then fast): `fast_dyn` connects while `slow_dyn` stays pending.
  await until(() =>
    hostOf(service).extensions.twin.names().includes("mcp__fast_dyn__ping"),
  );
  await until(() => turn >= 2);
  fs.rmSync(slowGate, { force: true });
  // Case 2 (fast then late): `fast2_dyn` connects while `late_dyn` (adopted by
  // fast2's handler) MUST still wait for lateGate rather than settling early.
  await until(() =>
    hostOf(service).extensions.twin.names().includes("mcp__fast2_dyn__ping"),
  );
  await until(() => turn >= 4);
  fs.rmSync(lateGate, { force: true });
  // Case 3 (replace): withdrawing old `ping` as hidden must not settle `ping2`.
  await until(() => turn >= 6);
  fs.rmSync(replaceGate, { force: true });
  await service.wait(["a"]);
  const result = service.get("a")?.result?.text ?? "";
  expect(result).toContain("slow-dyn-ok");
  expect(result).toContain("late-dyn-ok");
  expect(result).toContain("fast-v2");
});

test("reopened read-only codemode ignores newly hanging MCP servers, and computed resource-only replays wait lazily", async () => {
  // Part A: tools.read-only script with a short deadline whose previously-connected
  // MCP server hangs on reopen completes immediately without stalling.
  {
    const cwd = trackedTempDir("pi-agents-mcp-readonly-");
    const storageDir = trackedTempDir("pi-agents-mcp-readonly-store-");
    const script = mcpServerScript(cwd);
    const sampleFile = path.join(cwd, "note.txt");
    fs.writeFileSync(sampleFile, "read-only-ok");
    writeProjectMcp(cwd, {
      flaky: {
        command: process.execPath,
        args: [script],
        env: { REPLY_TEXT: "unused" },
      },
    });
    const makeModels = () => {
      const faux = fauxProvider();
      const models = createModels();
      models.setProvider(faux.provider);
      faux.setResponses(
        Array.from({ length: 4 }, () => (context) => {
          const last = context.messages.at(-1);
          if (last?.role === "toolResult")
            return fauxAssistantMessage(
              last.content
                .map((block) => (block.type === "text" ? block.text : ""))
                .join(""),
            );
          return fauxAssistantMessage(
            [
              fauxToolCall("codemode", {
                code: `// @options: {"timeout_ms": 2000}\nreturn await tools.read({ path: ${JSON.stringify(sampleFile)} });`,
              }),
            ],
            { stopReason: "toolUse" },
          );
        }),
      );
      return models;
    };
    const readEntered = gate();
    const before = await openService({
      cwd,
      trusted: true,
      twin: true,
      twinStartupWaitMs: 30_000,
      storage: await jsonlStorage(storageDir),
      taskHooks: [
        hook(ToolTask, {
          beforeTool: async (call, _api, context) => {
            if (call.name === "read") {
              readEntered.release();
              await heldUntilAborted(context.abortSignal);
            }
            return undefined;
          },
        }),
      ],
      models: makeModels(),
    });
    services.push(before);
    await until(() =>
      hostOf(before).extensions.twin.names().includes("mcp__flaky__ping"),
    );
    await before.spawnGraph({
      agents: [
        {
          name: "a",
          job: "readonly",
          cwd,
          model: MODEL,
          tools: ["read", "codemode"],
        },
      ],
    });
    await readEntered.promise;
    await closeService(before);
    services = services.filter((service) => service !== before);

    // On reopen, `flaky` now hangs forever; the read-only script must finish
    // immediately before its 2s timeout without waiting for `flaky`.
    writeProjectMcp(cwd, {
      flaky: {
        command: process.execPath,
        args: [script],
        env: { HANG: "1" },
      },
    });
    const after = await openService({
      cwd,
      trusted: true,
      twin: true,
      twinStartupWaitMs: 30_000,
      storage: await jsonlStorage(storageDir),
      models: makeModels(),
    });
    services.push(after);
    await after.wait(["a"]);
    expect(after.get("a")?.result?.text).toContain("read-only-ok");
  }

  // Part B: resource-only (0-tool) server + computed `list_mcp_resources` call
  // replays cleanly after restart by waiting lazily inside api.executeTool.
  {
    const cwd = trackedTempDir("pi-agents-mcp-resonly-");
    const storageDir = trackedTempDir("pi-agents-mcp-resonly-store-");
    const script = mcpServerScript(cwd);
    const sampleFile = path.join(cwd, "note.txt");
    fs.writeFileSync(sampleFile, "ok");
    writeProjectMcp(cwd, {
      resonly: {
        command: process.execPath,
        args: [script],
        env: { DELAY_MS: "150", NO_TOOLS: "1", RESOURCES: "1" },
      },
    });
    const makeModels = () => {
      const faux = fauxProvider();
      const models = createModels();
      models.setProvider(faux.provider);
      faux.setResponses(
        Array.from({ length: 4 }, () => (context) => {
          const last = context.messages.at(-1);
          if (last?.role === "toolResult")
            return fauxAssistantMessage(
              last.content
                .map((block) => (block.type === "text" ? block.text : ""))
                .join(""),
            );
          return fauxAssistantMessage(
            [
              fauxToolCall("codemode", {
                code: `await tools.read({ path: ${JSON.stringify(sampleFile)} });
const fn = ["list", "mcp", "resources"].join("_");
return JSON.stringify(await tools[fn]({}));`,
              }),
            ],
            { stopReason: "toolUse" },
          );
        }),
      );
      return models;
    };
    const readEntered = gate();
    const before = await openService({
      cwd,
      trusted: true,
      twin: true,
      twinStartupWaitMs: 30_000,
      storage: await jsonlStorage(storageDir),
      taskHooks: [
        hook(ToolTask, {
          beforeTool: async (call, _api, context) => {
            if (call.name === "read") {
              readEntered.release();
              await heldUntilAborted(context.abortSignal);
            }
            return undefined;
          },
        }),
      ],
      models: makeModels(),
    });
    services.push(before);
    await until(() =>
      hostOf(before).extensions.twin.names().includes("list_mcp_resources"),
    );
    await before.spawnGraph({
      agents: [
        {
          name: "a",
          job: "resonly",
          cwd,
          model: MODEL,
          tools: ["read", "codemode"],
        },
      ],
    });
    await readEntered.promise;
    await closeService(before);
    services = services.filter((service) => service !== before);

    const after = await openService({
      cwd,
      trusted: true,
      twin: true,
      twinStartupWaitMs: 30_000,
      storage: await jsonlStorage(storageDir),
      models: makeModels(),
    });
    services.push(after);
    await after.wait(["a"]);
    expect(after.get("a")?.result?.text).toContain("test://doc");
  }
});

test("direct server wait uses exact namespace even when another server has a tool of that exact name", async () => {
  const cwd = trackedTempDir("pi-agents-mcp-ns-collision-");
  const script = mcpServerScript(cwd);
  const directGate = path.join(cwd, "direct.hold");
  fs.writeFileSync(directGate, "1");
  writeProjectMcp(cwd, {
    // Exposes tool `mcp__alpha__ping` immediately.
    alpha: {
      command: process.execPath,
      args: [script],
      env: { TOOL_NAME: "ping", REPLY_TEXT: "alpha-ping" },
    },
    // Direct server whose namespace is ALSO `mcp__alpha__ping`.
    alpha__ping: {
      command: process.execPath,
      args: [script],
      env: {
        INIT_HOLD_FILE: directGate,
        TOOL_NAME: "greet",
        REPLY_TEXT: "direct-alpha-ping",
      },
      exposure: "direct",
    },
  });
  let turn1Tools: string[] = [];
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(
    Array.from({ length: 4 }, () => (context) => {
      if (turn1Tools.length === 0)
        turn1Tools = getCurrentTools(context.messages).map((tool) => tool.name);
      const last = context.messages.at(-1);
      if (last?.role === "toolResult")
        return fauxAssistantMessage(
          last.content
            .map((block) => (block.type === "text" ? block.text : ""))
            .join(""),
        );
      return fauxAssistantMessage(
        [fauxToolCall("mcp__alpha__ping__greet", {})],
        { stopReason: "toolUse" },
      );
    }),
  );
  const service = await openService({
    cwd,
    trusted: true,
    twin: true,
    twinStartupWaitMs: 30_000,
    models,
  });
  services.push(service);
  // Wait for `alpha` to register `mcp__alpha__ping` BEFORE spawning so the
  // tool name collision is active when waitForDirect() runs.
  await until(() =>
    hostOf(service).extensions.twin.names().includes("mcp__alpha__ping"),
  );
  const spawn = service.spawnGraph({
    agents: [
      { name: "a", job: "direct-ns", cwd, model: MODEL, tools: ["read"] },
    ],
  });
  fs.rmSync(directGate, { force: true });
  await spawn;
  await service.wait(["a"]);
  expect(turn1Tools).toContain("mcp__alpha__ping__greet");
  expect(service.get("a")?.result?.text).toBe("direct-alpha-ping");
});

test("recovered graph node before its first submission receives direct MCP tools", async () => {
  const cwd = trackedTempDir("pi-agents-mcp-graph-resume-");
  const storageDir = trackedTempDir("pi-agents-mcp-graph-storage-");
  const script = mcpServerScript(cwd);
  writeProjectMcp(cwd, {
    direct_srv: {
      command: process.execPath,
      args: [script],
      env: { DELAY_MS: "150", TOOL_NAME: "greet", REPLY_TEXT: "direct-ok" },
      exposure: "direct",
    },
  });
  const firstEntered = gate();
  const secondTools: string[] = [];
  const makeModels = (holdFirst: boolean) => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses(
      Array.from({ length: 8 }, () => async (context, options) => {
        const user = context.messages.find(
          (message) => message.role === "user",
        );
        const job =
          typeof user?.content === "string"
            ? user.content
            : (user?.content
                .flatMap((block) => (block.type === "text" ? [block.text] : []))
                .join("") ?? "");
        if (job === "first-job" && holdFirst) {
          firstEntered.release();
          await heldUntilAborted(options?.signal);
        }
        if (job.includes("second-job")) {
          if (secondTools.length === 0)
            secondTools.push(
              ...getCurrentTools(context.messages).map((tool) => tool.name),
            );
          const last = context.messages.at(-1);
          if (last?.role === "toolResult")
            return fauxAssistantMessage(
              last.content
                .map((block) => (block.type === "text" ? block.text : ""))
                .join(""),
            );
          return fauxAssistantMessage(
            [fauxToolCall("mcp__direct_srv__greet", {})],
            { stopReason: "toolUse" },
          );
        }
        return fauxAssistantMessage("first-done");
      }),
    );
    return models;
  };

  const before = await openService({
    cwd,
    trusted: true,
    twin: true,
    twinStartupWaitMs: 30_000,
    storage: await jsonlStorage(storageDir),
    models: makeModels(true),
  });
  services.push(before);
  await before.spawnGraph({
    name: "pipe",
    agents: [
      { name: "first", job: "first-job", cwd, model: MODEL, tools: ["read"] },
      {
        name: "second",
        job: "second-job",
        after: ["first"],
        cwd,
        model: MODEL,
        tools: ["read"],
      },
    ],
  });
  // Close while `first` is running and `second` is a waiting NodeTask with no
  // generation or submission yet.
  await firstEntered.promise;
  await closeService(before);
  services = services.filter((service) => service !== before);

  const after = await openService({
    cwd,
    trusted: true,
    twin: true,
    twinStartupWaitMs: 30_000,
    storage: await jsonlStorage(storageDir),
    models: makeModels(false),
  });
  services.push(after);
  await after.wait(["pipe"]);
  expect(secondTools).toContain("mcp__direct_srv__greet");
  expect(after.get("second")?.result?.text).toBe("direct-ok");
});

test("replayed codemode skips waiting for literal and computed MCP calls whose results are already durable", async () => {
  const cwd = trackedTempDir("pi-agents-mcp-durable-replay-");
  const storageDir = trackedTempDir("pi-agents-mcp-durable-store-");
  const script = mcpServerScript(cwd);
  const sampleFile = path.join(cwd, "after.txt");
  fs.writeFileSync(sampleFile, "after-ok");
  writeProjectMcp(cwd, {
    flaky: {
      command: process.execPath,
      args: [script],
      env: { REPLY_TEXT: "durable-pong" },
    },
  });
  const makeModels = () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses(
      Array.from({ length: 4 }, () => (context) => {
        const last = context.messages.at(-1);
        if (last?.role === "toolResult")
          return fauxAssistantMessage(
            last.content
              .map((block) => (block.type === "text" ? block.text : ""))
              .join(""),
          );
        return fauxAssistantMessage(
          [
            fauxToolCall("codemode", {
              code: `// @options: {"timeout_ms": 2000}
const lit = await tools.mcp__flaky__ping({});
const comp = await tools[["mcp", "flaky", "ping"].join("__")]({});
const after = await tools.read({ path: ${JSON.stringify(sampleFile)} });
return JSON.stringify({ lit, comp, after });`,
            }),
          ],
          { stopReason: "toolUse" },
        );
      }),
    );
    return models;
  };

  const readEntered = gate();
  const before = await openService({
    cwd,
    trusted: true,
    twin: true,
    twinStartupWaitMs: 30_000,
    storage: await jsonlStorage(storageDir),
    taskHooks: [
      hook(ToolTask, {
        beforeTool: async (call, _api, context) => {
          if (call.name === "read") {
            readEntered.release();
            await heldUntilAborted(context.abortSignal);
          }
          return undefined;
        },
      }),
    ],
    models: makeModels(),
  });
  services.push(before);
  await before.spawnGraph({
    agents: [
      {
        name: "a",
        job: "durable-replay",
        cwd,
        model: MODEL,
        tools: ["read", "codemode"],
      },
    ],
  });
  // Both MCP calls have settled durably once `read` is reached.
  await readEntered.promise;
  await closeService(before);
  services = services.filter((service) => service !== before);

  // On reopen, `flaky` hangs forever: replay must return both durable MCP
  // results without waiting on `flaky` or hitting the 2s script deadline.
  writeProjectMcp(cwd, {
    flaky: {
      command: process.execPath,
      args: [script],
      env: { HANG: "1" },
    },
  });
  const after = await openService({
    cwd,
    trusted: true,
    twin: true,
    twinStartupWaitMs: 30_000,
    storage: await jsonlStorage(storageDir),
    models: makeModels(),
  });
  services.push(after);
  await after.wait(["a"]);
  const text = after.get("a")?.result?.text ?? "";
  expect(text).toContain("durable-pong");
  expect(text).toContain("after-ok");
});

test("in-progress waits recheck tool ownership and direct server replacements mid-wait", async () => {
  // Part A: `mcp__left__right__ping` initially matches both `left` (hanging)
  // and `left__right` (connecting). Once `left__right` registers the tool,
  // `waitFor` narrows ownership immediately without waiting for `left`.
  {
    const cwd = trackedTempDir("pi-agents-mcp-narrow-");
    const script = mcpServerScript(cwd);
    writeProjectMcp(cwd, {
      left: {
        command: process.execPath,
        args: [script],
        env: { HANG: "1" },
      },
      left__right: {
        command: process.execPath,
        args: [script],
        env: { DELAY_MS: "120", TOOL_NAME: "ping", REPLY_TEXT: "lr-ok" },
      },
    });
    const twin = await ToolTwin.open({
      cwd,
      extensions: [],
      trusted: true,
      startupWaitMs: 30_000,
      onProblem: () => {},
    });
    try {
      await twin.waitFor(["mcp__left__right__ping"]);
      expect(
        twin
          .tools()
          .some((tool) => tool.info.name === "mcp__left__right__ping"),
      ).toBe(true);
    } finally {
      await twin.close();
    }
  }

  // Part B: replacing a connecting `direct` server mid-wait keeps
  // `waitForDirect()` waiting until the replacement settles.
  {
    const cwd = trackedTempDir("pi-agents-mcp-direct-replace-");
    const script = mcpServerScript(cwd);
    const v1Gate = path.join(cwd, "v1.hold");
    const v2Gate = path.join(cwd, "v2.hold");
    fs.writeFileSync(v1Gate, "1");
    fs.writeFileSync(v2Gate, "1");
    const pkg = trackedTempDir("pi-agents-direct-replace-ext-");
    fs.writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({
        name: "direct-replace",
        pi: { extensions: ["./ext.ts"] },
      }),
    );
    fs.writeFileSync(
      path.join(pkg, "ext.ts"),
      `import { Type } from "typebox";
export default function (pi) {
  pi.registerMcpServer("dyn_direct", {
    command: ${JSON.stringify(process.execPath)},
    args: [${JSON.stringify(script)}],
    env: { INIT_HOLD_FILE: ${JSON.stringify(v1Gate)}, TOOL_NAME: "greet1", REPLY_TEXT: "v1" },
    exposure: "direct",
  });
  pi.registerTool({
    name: "swap_direct",
    label: "Swap Direct",
    description: "Replace dyn_direct while it is still connecting",
    parameters: Type.Object({}),
    async execute() {
      pi.unregisterMcpServer("dyn_direct");
      pi.registerMcpServer("dyn_direct", {
        command: ${JSON.stringify(process.execPath)},
        args: [${JSON.stringify(script)}],
        env: { INIT_HOLD_FILE: ${JSON.stringify(v2Gate)}, TOOL_NAME: "greet2", REPLY_TEXT: "v2" },
        exposure: "direct",
      });
      return { content: [{ type: "text", text: "swapped" }], details: {} };
    },
  });
}
`,
    );
    const twin = await ToolTwin.open({
      cwd,
      extensions: [pkg],
      trusted: true,
      startupWaitMs: 30_000,
      onProblem: () => {},
    });
    try {
      let directSettled = false;
      const waiting = twin.waitForDirect().then(() => {
        directSettled = true;
      });
      // Replace dyn_direct mid-wait while v1 is still held behind v1Gate.
      await twin.call("swap_direct", {}, undefined, () => {});
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(directSettled).toBe(false);
      // Now release v2Gate; waitForDirect must resolve once greet2 registers.
      fs.rmSync(v2Gate, { force: true });
      await waiting;
      expect(
        twin
          .tools()
          .some((tool) => tool.info.name === "mcp__dyn_direct__greet2"),
      ).toBe(true);
    } finally {
      fs.rmSync(v1Gate, { force: true });
      fs.rmSync(v2Gate, { force: true });
      await twin.close();
    }
  }
});

test("resource-only dynamic server settles without waiting for a hanging sibling in the same batch", async () => {
  const cwd = trackedTempDir("pi-agents-mcp-res-batch-");
  const script = mcpServerScript(cwd);
  const pkg = trackedTempDir("pi-agents-res-batch-ext-");
  fs.writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify({ name: "res-batch", pi: { extensions: ["./ext.ts"] } }),
  );
  fs.writeFileSync(
    path.join(pkg, "ext.ts"),
    `import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({
    name: "register_res_and_hang",
    label: "Register Res and Hang",
    description: "Register resource-only docs and hanging server together",
    parameters: Type.Object({}),
    async execute() {
      pi.registerMcpServer("res_dyn", {
        command: ${JSON.stringify(process.execPath)},
        args: [${JSON.stringify(script)}],
        env: { NO_TOOLS: "1", RESOURCES: "1" },
      });
      pi.registerMcpServer("hang_dyn", {
        command: ${JSON.stringify(process.execPath)},
        args: [${JSON.stringify(script)}],
        env: { HANG: "1" },
      });
      return { content: [{ type: "text", text: "registered" }], details: {} };
    },
  });
}
`,
  );
  const twin = await ToolTwin.open({
    cwd,
    extensions: [pkg],
    trusted: true,
    startupWaitMs: 30_000,
    onProblem: () => {},
  });
  try {
    await twin.call("register_res_and_hang", {}, undefined, () => {});
    // 30s startupWaitMs: `res_dyn` (0 namespaced tools) must settle as soon as
    // it connects, without waiting for `hang_dyn` in the same batch.
    await twin.waitFor(["mcp__res_dyn"]);
    expect(
      twin.tools().some((tool) => tool.info.name === "list_mcp_resources"),
    ).toBe(true);
  } finally {
    await twin.close();
  }
});

test("shared tools declaring reachesTools bound Pi's MCP readiness wait without timing out execute()", async () => {
  const cwd = trackedTempDir("pi-agents-mcp-reaches-");
  const script = mcpServerScript(cwd);
  writeProjectMcp(cwd, {
    hanging: {
      command: process.execPath,
      args: [script],
      env: { HANG: "1" },
    },
  });
  const pkg = trackedTempDir("pi-agents-reaches-ext-");
  fs.writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify({ name: "reaches-all", pi: { extensions: ["./ext.ts"] } }),
  );
  fs.writeFileSync(
    path.join(pkg, "ext.ts"),
    `import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({
    name: "reach_all",
    label: "Reach All",
    description: "Shared tool declaring reachesTools",
    parameters: Type.Object({}),
    reachesTools: () => "all",
    async execute(_id, _params, signal) {
      // Runs longer than startupWaitMs after the readiness wait ends to prove
      // execute() itself is not aborted by the startup wait budget.
      await new Promise((resolve) => setTimeout(resolve, 120));
      if (signal?.aborted) throw new Error("unexpected abort");
      return { content: [{ type: "text", text: "reached-ok" }], details: {} };
    },
  });
}
`,
  );
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(
    Array.from({ length: 4 }, () => (context) => {
      const last = context.messages.at(-1);
      if (last?.role === "toolResult")
        return fauxAssistantMessage(
          last.content
            .map((block) => (block.type === "text" ? block.text : ""))
            .join(""),
        );
      return fauxAssistantMessage([fauxToolCall("reach_all", {})], {
        stopReason: "toolUse",
      });
    }),
  );
  const service = await openService({
    cwd,
    trusted: true,
    twinExtensions: [pkg],
    twinStartupWaitMs: 250,
    models,
  });
  services.push(service);
  await service.spawnGraph({
    agents: [
      { name: "a", job: "call-reach", cwd, model: MODEL, tools: ["read"] },
    ],
  });
  await service.wait(["a"]);
  expect(service.get("a")?.result?.text).toBe("reached-ok");
});

test("codemode crashed in execute phase before writing pi.codemode.run.start waits for pending servers (including computed tool names)", async () => {
  const cwd = trackedTempDir("pi-agents-mcp-prestart-");
  const storageDir = trackedTempDir("pi-agents-mcp-prestart-store-");
  const script = mcpServerScript(cwd);
  writeProjectMcp(cwd, {
    hanging: {
      command: process.execPath,
      args: [script],
      env: { HANG: "1" },
    },
    slow: {
      command: process.execPath,
      args: [script],
      env: { DELAY_MS: "120", REPLY_TEXT: "prestart-pong" },
    },
  });
  const makeModels = () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses(
      Array.from({ length: 4 }, () => (context) => {
        const last = context.messages.at(-1);
        if (last?.role === "toolResult")
          return fauxAssistantMessage(
            last.content
              .map((block) => (block.type === "text" ? block.text : ""))
              .join(""),
          );
        // Dynamically computed tool name: source scanning alone cannot see `mcp__slow`.
        return fauxAssistantMessage(
          [
            fauxToolCall("codemode", {
              code: 'const fn = ["mcp", "slow", "ping"].join("__"); return await tools[fn]({});',
            }),
          ],
          { stopReason: "toolUse" },
        );
      }),
    );
    return models;
  };

  // Session 1: hold inside `codemode.execute()` BEFORE `pi.codemode.run.start`
  // is written so `ToolTask` commits `phase: "execute"` with no `start` doc.
  const executeEntered = gate();
  const baseExtensions = testExtensions({ trusted: true });
  const wrappedTools = {
    ...baseExtensions.tools,
    tools: (baseExtensions.tools.tools ?? []).map((tool) =>
      tool.name === CODEMODE_TOOL_NAME
        ? {
            ...tool,
            async execute(
              _args: unknown,
              _api: unknown,
              context: { abortSignal?: AbortSignal },
            ) {
              executeEntered.release();
              await heldUntilAborted(context.abortSignal);
              return { output: [] };
            },
          }
        : tool,
    ),
  };
  const extensions = { ...baseExtensions, tools: wrappedTools };
  const harness = await openAgentHarness({
    storage: await jsonlStorage(storageDir),
    models: makeModels(),
    identity: { attribution: null },
    cwd,
    extensions,
    twin: {
      extensions: [],
      trusted: true,
      startupWaitMs: 400,
      onProblem: () => {},
    },
  });
  const beforeService = await AgentServiceClass.start({
    harness: harness.harness,
    anchor: harness.anchor,
    extensions,
    parent: new TestParent(),
    refreshDelayMs: 5,
  });
  harness.harness.resume();
  try {
    await beforeService.spawnGraph({
      agents: [
        { name: "a", job: "prestart", cwd, model: MODEL, tools: ["codemode"] },
      ],
    });
    await executeEntered.promise;
  } finally {
    await beforeService.close();
    await harness.close();
  }

  // Session 2: `codemode` resumes directly in `execute` with no `start` doc;
  // `waitForResumedMcp` waits up to `startupWaitMs` for all pending servers so
  // the initial catalog contains `mcp__slow__ping` even for computed names.
  const after = await openService({
    cwd,
    trusted: true,
    twin: true,
    twinStartupWaitMs: 400,
    storage: await jsonlStorage(storageDir),
    models: makeModels(),
  });
  services.push(after);
  await after.wait(["a"]);
  expect(after.get("a")?.result?.text).toContain("prestart-pong");
});

test("resumed ambiguous MCP tool call narrows ownership mid-wait instead of stalling on hanging prefix sibling", async () => {
  const cwd = trackedTempDir("pi-agents-mcp-resume-narrow-");
  const storageDir = trackedTempDir("pi-agents-mcp-resume-narrow-store-");
  const script = mcpServerScript(cwd);
  const holdFile = path.join(cwd, "hold");
  const startedFile = path.join(cwd, "started");
  fs.writeFileSync(holdFile, "1");
  writeProjectMcp(cwd, {
    left: {
      command: process.execPath,
      args: [script],
      env: { HANG: "1" },
    },
    left__right: {
      command: process.execPath,
      args: [script],
      env: {
        DELAY_MS: "120",
        TOOL_NAME: "ping",
        REPLY_TEXT: "lr-resumed",
        CALL_HOLD_FILE: holdFile,
        CALL_STARTED_FILE: startedFile,
      },
      exposure: "direct",
    },
  });
  const makeModels = () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses(
      Array.from({ length: 4 }, () => (context) => {
        const last = context.messages.at(-1);
        if (last?.role === "toolResult")
          return fauxAssistantMessage(
            last.content
              .map((block) => (block.type === "text" ? block.text : ""))
              .join(""),
          );
        return fauxAssistantMessage(
          [fauxToolCall("mcp__left__right__ping", {})],
          { stopReason: "toolUse" },
        );
      }),
    );
    return models;
  };

  const before = await openService({
    cwd,
    trusted: true,
    twin: true,
    twinStartupWaitMs: 30_000,
    storage: await jsonlStorage(storageDir),
    models: makeModels(),
  });
  services.push(before);
  await before.spawnGraph({
    agents: [{ name: "a", job: "lr", cwd, model: MODEL, tools: ["read"] }],
  });
  await until(() => fs.existsSync(startedFile));
  await closeService(before);
  services = services.filter((service) => service !== before);
  fs.rmSync(holdFile, { force: true });

  // Reopen with 30s startupWaitMs: `waitForResumedMcp` passes the raw tool
  // name to `twin.waitFor()`, which narrows ownership to `left__right` as soon
  // as it connects instead of blocking on hanging `left`.
  const after = await openService({
    cwd,
    trusted: true,
    twin: true,
    twinStartupWaitMs: 30_000,
    storage: await jsonlStorage(storageDir),
    models: makeModels(),
  });
  services.push(after);
  await after.wait(["a"]);
  expect(after.get("a")?.result?.text).toBe("lr-resumed");
});

test("replacing a hidden server waits for old close + replacement, and replacing + resource-only + hanging batch settles independently", async () => {
  // Part A: replacing a connected `hidden` server (slow close) with a `direct`
  // server does not settle during `old.close()` or before the replacement connects.
  {
    const cwd = trackedTempDir("pi-agents-mcp-hidden-replace-");
    const script = mcpServerScript(cwd);
    const newGate = path.join(cwd, "new.hold");
    fs.writeFileSync(newGate, "1");
    const pkg = trackedTempDir("pi-agents-hidden-replace-ext-");
    fs.writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({
        name: "hidden-replace",
        pi: { extensions: ["./ext.ts"] },
      }),
    );
    fs.writeFileSync(
      path.join(pkg, "ext.ts"),
      `import { Type } from "typebox";
export default function (pi) {
  pi.registerMcpServer("hid_srv", {
    command: ${JSON.stringify(process.execPath)},
    args: [${JSON.stringify(script)}],
    env: { CLOSE_DELAY_MS: "120", TOOL_NAME: "old_tool" },
    exposure: "hidden",
  });
  pi.registerTool({
    name: "promote_hidden",
    label: "Promote Hidden",
    description: "Replace hidden server with direct server",
    parameters: Type.Object({}),
    async execute() {
      pi.registerMcpServer("hid_srv", {
        command: ${JSON.stringify(process.execPath)},
        args: [${JSON.stringify(script)}],
        env: { INIT_HOLD_FILE: ${JSON.stringify(newGate)}, TOOL_NAME: "greet2", REPLY_TEXT: "promoted" },
        exposure: "direct",
      });
      return { content: [{ type: "text", text: "ok" }], details: {} };
    },
  });
}
`,
    );
    const twin = await ToolTwin.open({
      cwd,
      extensions: [pkg],
      trusted: true,
      startupWaitMs: 30_000,
      onProblem: () => {},
    });
    try {
      // Let initial hidden server finish connecting before replacing it.
      await new Promise((resolve) => setTimeout(resolve, 100));
      await twin.call("promote_hidden", {}, undefined, () => {});
      let settled = false;
      const waiting = twin.waitForDirect().then(() => {
        settled = true;
      });
      // Wait past old.close() while newGate is still held: must not settle early.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(settled).toBe(false);
      fs.rmSync(newGate, { force: true });
      await waiting;
      expect(
        twin.tools().some((tool) => tool.info.name === "mcp__hid_srv__greet2"),
      ).toBe(true);
    } finally {
      fs.rmSync(newGate, { force: true });
      await twin.close();
    }
  }

  // Part B: replacing a visible server (slow close) with a resource-only
  // (0-tool) server alongside a hanging sibling settles without waiting on hang.
  {
    const cwd = trackedTempDir("pi-agents-mcp-replace-res-");
    const script = mcpServerScript(cwd);
    const pkg = trackedTempDir("pi-agents-replace-res-ext-");
    fs.writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({ name: "replace-res", pi: { extensions: ["./ext.ts"] } }),
    );
    fs.writeFileSync(
      path.join(pkg, "ext.ts"),
      `import { Type } from "typebox";
export default function (pi) {
  pi.registerMcpServer("vis_srv", {
    command: ${JSON.stringify(process.execPath)},
    args: [${JSON.stringify(script)}],
    env: { CLOSE_DELAY_MS: "100", TOOL_NAME: "v1_tool" },
  });
  pi.registerTool({
    name: "replace_with_res_and_hang",
    label: "Replace With Res And Hang",
    description: "Replace vis_srv with resource-only server and add hanging sibling",
    parameters: Type.Object({}),
    async execute() {
      pi.registerMcpServer("vis_srv", {
        command: ${JSON.stringify(process.execPath)},
        args: [${JSON.stringify(script)}],
        env: { NO_TOOLS: "1", RESOURCES: "1" },
      });
      pi.registerMcpServer("hang_sib", {
        command: ${JSON.stringify(process.execPath)},
        args: [${JSON.stringify(script)}],
        env: { HANG: "1" },
      });
      return { content: [{ type: "text", text: "ok" }], details: {} };
    },
  });
}
`,
    );
    const twin = await ToolTwin.open({
      cwd,
      extensions: [pkg],
      trusted: true,
      startupWaitMs: 30_000,
      onProblem: () => {},
    });
    try {
      await twin.waitFor(["mcp__vis_srv"]);
      await twin.call("replace_with_res_and_hang", {}, undefined, () => {});
      // Must wait past old.close() and settle once resource-only vis_srv
      // connects, without waiting 30s on hang_sib in the same batch.
      await twin.waitFor(["mcp__vis_srv"]);
      expect(
        twin.tools().some((tool) => tool.info.name === "list_mcp_resources"),
      ).toBe(true);
    } finally {
      await twin.close();
    }
  }
});

test("shared tool declaring substring reachesTools waits for matching MCP server", async () => {
  const cwd = trackedTempDir("pi-agents-mcp-reaches-sub-");
  const script = mcpServerScript(cwd);
  writeProjectMcp(cwd, {
    hanging: {
      command: process.execPath,
      args: [script],
      env: { HANG: "1" },
    },
    docs: {
      command: process.execPath,
      args: [script],
      env: { DELAY_MS: "150", TOOL_NAME: "ping", REPLY_TEXT: "docs-sub" },
    },
  });
  const pkg = trackedTempDir("pi-agents-reaches-sub-ext-");
  fs.writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify({ name: "reaches-sub", pi: { extensions: ["./ext.ts"] } }),
  );
  fs.writeFileSync(
    path.join(pkg, "ext.ts"),
    `import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({
    name: "reach_sub",
    label: "Reach Sub",
    description: "Shared tool with substring reachesTools",
    parameters: Type.Object({}),
    reachesTools: () => ["prefix_mcp__docs__ping"],
    async execute() {
      const hasDocs = pi.getAllTools().some((tool) => tool.name === "mcp__docs__ping");
      return { content: [{ type: "text", text: hasDocs ? "saw-docs" : "missed-docs" }], details: {} };
    },
  });
}
`,
  );
  const twin = await ToolTwin.open({
    cwd,
    extensions: [pkg],
    trusted: true,
    startupWaitMs: 30_000,
    onProblem: () => {},
  });
  try {
    const result = await twin.call("reach_sub", {}, undefined, () => {});
    const text = result.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
    expect(text).toBe("saw-docs");
  } finally {
    await twin.close();
  }
});

test("shared tool with reachesTools waits while a target replacement server is still closing its old transport", async () => {
  const cwd = trackedTempDir("pi-agents-mcp-reaches-replace-");
  const script = mcpServerScript(cwd);
  const pkg = trackedTempDir("pi-agents-reaches-replace-ext-");
  fs.writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify({
      name: "reaches-replace",
      pi: { extensions: ["./ext.ts"] },
    }),
  );
  fs.writeFileSync(
    path.join(pkg, "ext.ts"),
    `import { Type } from "typebox";
export default function (pi) {
  pi.registerMcpServer("rep_srv", {
    command: ${JSON.stringify(process.execPath)},
    args: [${JSON.stringify(script)}],
    env: { CLOSE_DELAY_MS: "120", TOOL_NAME: "v1_tool" },
  });
  pi.registerTool({
    name: "trigger_replace",
    label: "Trigger Replace",
    description: "Replace rep_srv with v2_tool",
    parameters: Type.Object({}),
    async execute() {
      pi.registerMcpServer("rep_srv", {
        command: ${JSON.stringify(process.execPath)},
        args: [${JSON.stringify(script)}],
        env: { DELAY_MS: "60", TOOL_NAME: "v2_tool" },
      });
      return { content: [{ type: "text", text: "replaced" }], details: {} };
    },
  });
  pi.registerTool({
    name: "inspect_rep",
    label: "Inspect Rep",
    description: "Waits for rep_srv via reachesTools and checks for v2_tool",
    parameters: Type.Object({}),
    reachesTools: () => ["mcp__rep_srv"],
    async execute() {
      const hasV2 = pi.getAllTools().some((tool) => tool.name === "mcp__rep_srv__v2_tool");
      return { content: [{ type: "text", text: hasV2 ? "saw-v2" : "missed-v2" }], details: {} };
    },
  });
}
`,
  );
  const twin = await ToolTwin.open({
    cwd,
    extensions: [pkg],
    trusted: true,
    startupWaitMs: 30_000,
    onProblem: () => {},
  });
  try {
    await twin.waitFor(["mcp__rep_srv"]);
    await twin.call("trigger_replace", {}, undefined, () => {});
    // Call `inspect_rep` immediately while v1 is still in its 120ms close:
    // runMcpToolCall must wait through `awaitingStart` AND v2's startup.
    const result = await twin.call("inspect_rep", {}, undefined, () => {});
    const text = result.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
    expect(text).toBe("saw-v2");
  } finally {
    await twin.close();
  }
});

test("shared extension tool in an mcp__* namespace does not falsely mark a direct MCP server ready at startup", async () => {
  const cwd = trackedTempDir("pi-agents-mcp-ns-share-");
  const script = mcpServerScript(cwd);
  writeProjectMcp(cwd, {
    docs: {
      command: process.execPath,
      args: [script],
      env: { DELAY_MS: "150", TOOL_NAME: "search", REPLY_TEXT: "docs-ok" },
      exposure: "direct",
    },
  });
  const pkg = trackedTempDir("pi-agents-ns-share-ext-");
  fs.writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify({ name: "ns-share", pi: { extensions: ["./ext.ts"] } }),
  );
  fs.writeFileSync(
    path.join(pkg, "ext.ts"),
    `import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({
    name: "shared_docs_helper",
    label: "Shared Docs Helper",
    description: "Shared tool placed in mcp__docs namespace",
    namespace: { name: "mcp__docs", description: "Shared helper" },
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "helper" }], details: {} };
    },
  });
}
`,
  );
  const twin = await ToolTwin.open({
    cwd,
    extensions: [pkg],
    trusted: true,
    startupWaitMs: 30_000,
    onProblem: () => {},
  });
  try {
    await twin.waitForDirect();
    expect(
      twin.tools().some((tool) => tool.info.name === "mcp__docs__search"),
    ).toBe(true);
  } finally {
    await twin.close();
  }
});

test("shared tool with reachesTools keeps waiting when its target server is replaced mid-wait", async () => {
  const cwd = trackedTempDir("pi-agents-mcp-reaches-midwait-");
  const script = mcpServerScript(cwd);
  const v1Gate = path.join(cwd, "v1.hold");
  const v2Gate = path.join(cwd, "v2.hold");
  fs.writeFileSync(v1Gate, "1");
  fs.writeFileSync(v2Gate, "1");
  const pkg = trackedTempDir("pi-agents-reaches-midwait-ext-");
  fs.writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify({
      name: "reaches-midwait",
      pi: { extensions: ["./ext.ts"] },
    }),
  );
  fs.writeFileSync(
    path.join(pkg, "ext.ts"),
    `import { Type } from "typebox";
export default function (pi) {
  pi.registerMcpServer("mid_srv", {
    command: ${JSON.stringify(process.execPath)},
    args: [${JSON.stringify(script)}],
    env: { INIT_HOLD_FILE: ${JSON.stringify(v1Gate)}, TOOL_NAME: "v1_tool" },
  });
  pi.registerTool({
    name: "swap_mid",
    label: "Swap Mid",
    description: "Replace mid_srv mid-wait",
    parameters: Type.Object({}),
    async execute() {
      pi.registerMcpServer("mid_srv", {
        command: ${JSON.stringify(process.execPath)},
        args: [${JSON.stringify(script)}],
        env: { INIT_HOLD_FILE: ${JSON.stringify(v2Gate)}, TOOL_NAME: "v2_tool" },
      });
      return { content: [{ type: "text", text: "swapped" }], details: {} };
    },
  });
  pi.registerTool({
    name: "inspect_mid",
    label: "Inspect Mid",
    description: "Waits for mid_srv via reachesTools",
    parameters: Type.Object({}),
    reachesTools: () => ["mcp__mid_srv"],
    async execute() {
      const hasV2 = pi.getAllTools().some((tool) => tool.name === "mcp__mid_srv__v2_tool");
      return { content: [{ type: "text", text: hasV2 ? "saw-v2" : "missed-v2" }], details: {} };
    },
  });
}
`,
  );
  const twin = await ToolTwin.open({
    cwd,
    extensions: [pkg],
    trusted: true,
    startupWaitMs: 30_000,
    onProblem: () => {},
  });
  try {
    let finished = false;
    const calling = twin
      .call("inspect_mid", {}, undefined, () => {})
      .then((r) => {
        finished = true;
        return r;
      });
    // Replace mid_srv while inspect_mid is waiting on v1.
    await new Promise((resolve) => setTimeout(resolve, 40));
    await twin.call("swap_mid", {}, undefined, () => {});
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(finished).toBe(false);
    // Release v2; inspect_mid must now complete and observe v2_tool.
    fs.rmSync(v2Gate, { force: true });
    const result = await calling;
    const text = result.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
    expect(text).toBe("saw-v2");
  } finally {
    fs.rmSync(v1Gate, { force: true });
    fs.rmSync(v2Gate, { force: true });
    await twin.close();
  }
});

test("codemode calling a shared extension tool in namespace mcp__docs does not wait for hanging docs", async () => {
  const cwd = trackedTempDir("pi-agents-mcp-shared-in-ns-");
  const script = mcpServerScript(cwd);
  writeProjectMcp(cwd, {
    docs: {
      command: process.execPath,
      args: [script],
      env: { HANG: "1" },
    },
  });
  const pkg = trackedTempDir("pi-agents-shared-in-ns-ext-");
  fs.writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify({ name: "shared-in-ns", pi: { extensions: ["./ext.ts"] } }),
  );
  fs.writeFileSync(
    path.join(pkg, "ext.ts"),
    `import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({
    name: "mcp__docs__helper",
    label: "Shared Docs Helper",
    description: "Non-MCP shared tool in mcp__docs namespace",
    namespace: { name: "mcp__docs", description: "Shared helper" },
    exposure: "codemode",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "shared-helper-ok" }], details: {} };
    },
  });
}
`,
  );
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(
    Array.from({ length: 4 }, () => (context) => {
      const last = context.messages.at(-1);
      if (last?.role === "toolResult")
        return fauxAssistantMessage(
          last.content
            .map((block) => (block.type === "text" ? block.text : ""))
            .join(""),
        );
      return fauxAssistantMessage(
        [
          fauxToolCall("codemode", {
            code: "return await tools.mcp__docs__helper({});",
          }),
        ],
        { stopReason: "toolUse" },
      );
    }),
  );
  // 30s startupWaitMs: calling non-MCP `mcp__docs__helper` must return
  // immediately instead of stalling 30s on hanging MCP server `docs`.
  const service = await openService({
    cwd,
    trusted: true,
    twinExtensions: [pkg],
    twinStartupWaitMs: 30_000,
    models,
  });
  services.push(service);
  await service.spawnGraph({
    agents: [
      { name: "a", job: "call-helper", cwd, model: MODEL, tools: ["codemode"] },
    ],
  });
  await service.wait(["a"]);
  expect(service.get("a")?.result?.text).toContain("shared-helper-ok");
});
