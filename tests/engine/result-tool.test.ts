import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Compile } from "typebox/compile";
import {
  CONFIGURE_RESULT_COMMAND,
  decodeResultToolConfiguration,
  encodeConfigureResultPrompt,
} from "../../src/engine/result-protocol.js";
import resultToolExtension, {
  RESULT_TOOL_NAME,
} from "../../src/engine/result-tool.js";

interface CapturedTool {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: TSchema;
  execute(
    toolCallId: string,
    params: unknown,
  ): Promise<{
    details?: unknown;
    terminate?: boolean;
  }>;
}

interface Harness {
  configure(args: string): Promise<void>;
  tool(): CapturedTool;
  activeTools: string[];
  commandName?: string;
}

function harness(initialActiveTools: string[] = ["read"]): Harness {
  let captured: CapturedTool | undefined;
  let handler: ((args: string) => Promise<void>) | undefined;
  let commandName: string | undefined;
  const state: Harness = {
    activeTools: [...initialActiveTools],
    async configure(args: string) {
      if (!handler) throw new Error("configure command was not registered");
      await handler(args);
    },
    tool() {
      if (!captured) throw new Error("result tool was not registered");
      return captured;
    },
    get commandName() {
      return commandName;
    },
  };
  const pi = {
    registerTool(tool: CapturedTool) {
      captured = tool;
    },
    registerCommand(
      name: string,
      command: { handler: (args: string) => Promise<void> },
    ) {
      commandName = name;
      handler = command.handler;
    },
    getActiveTools: () => [...state.activeTools],
    setActiveTools(tools: string[]) {
      state.activeTools = tools;
    },
  } as unknown as ExtensionAPI;
  resultToolExtension(pi);
  return state;
}

function configuration(
  schema: unknown = { type: "string" },
  holdFile = "/nonexistent/pi-agents-hold",
): string {
  return JSON.stringify({ version: 1, resultSchema: schema, holdFile });
}

async function register(
  schema: unknown = { type: "string" },
): Promise<CapturedTool> {
  const state = harness();
  await state.configure(configuration(schema));
  return state.tool();
}

describe("result protocol", () => {
  test("encode and decode round-trip through the prompt wire format", () => {
    const config = {
      version: 1 as const,
      resultSchema: { type: "object" },
      holdFile: "/tmp/hold",
    };
    const prompt = encodeConfigureResultPrompt(config);
    expect(prompt.startsWith(`/${CONFIGURE_RESULT_COMMAND} `)).toBe(true);
    const args = prompt.slice(prompt.indexOf(" ") + 1);
    expect(decodeResultToolConfiguration(args)).toEqual(config);
  });

  test("rejects malformed and unsupported configurations", () => {
    expect(() => decodeResultToolConfiguration("not JSON")).toThrow(
      "Could not parse",
    );
    expect(() => decodeResultToolConfiguration('"just a string"')).toThrow(
      "must be a JSON object",
    );
    expect(() =>
      decodeResultToolConfiguration(
        JSON.stringify({ version: 2, resultSchema: {}, holdFile: "/h" }),
      ),
    ).toThrow("Unsupported result-tool configuration version");
    expect(() =>
      decodeResultToolConfiguration(JSON.stringify({ version: 1 })),
    ).toThrow("result schema");
    expect(() =>
      decodeResultToolConfiguration(
        JSON.stringify({ version: 1, resultSchema: {} }),
      ),
    ).toThrow("hold file");
  });
});

describe("configuration command", () => {
  test("registers under the versioned protocol name", () => {
    expect(harness().commandName).toBe(CONFIGURE_RESULT_COMMAND);
  });

  test("registers and activates the result tool alongside existing tools", async () => {
    const state = harness(["read", "bash"]);
    await state.configure(configuration());
    expect(state.tool().name).toBe(RESULT_TOOL_NAME);
    expect(state.activeTools).toEqual(["read", "bash", RESULT_TOOL_NAME]);
  });

  test("configures exactly once", async () => {
    const state = harness();
    await state.configure(configuration());
    await expect(state.configure(configuration())).rejects.toThrow(
      "already configured",
    );
  });

  test("survives JSON payloads with quotes, unicode, and escapes", async () => {
    const schema = {
      type: "object",
      properties: {
        note: { type: "string", description: 'say "hÿ"\nnew line — ok' },
      },
    };
    const tool = await register(schema);
    const parameters = tool.parameters as {
      properties: { result: { properties: { note: { description: string } } } };
    };
    expect(parameters.properties.result.properties.note.description).toBe(
      'say "hÿ"\nnew line — ok',
    );
  });

  test("rejects a malformed payload without registering a tool", async () => {
    const state = harness();
    await expect(state.configure("{broken")).rejects.toThrow("Could not parse");
    expect(() => state.tool()).toThrow("was not registered");
    expect(state.activeTools).toEqual(["read"]);
  });
});

describe("agent result tool", () => {
  test("describes semantic submission without prompt-name coupling", async () => {
    const tool = await register();
    expect(tool.name).toBe(RESULT_TOOL_NAME);
    expect(tool.label).toBe("Submit Agent Result");
    expect(tool.description).toContain(
      "Submit the complete result of this delegated assignment",
    );
    expect(tool.description).toContain("cannot be completed");
    const prompt = [tool.promptSnippet, ...(tool.promptGuidelines ?? [])].join(
      "\n",
    );
    expect(prompt).toContain("complete agent result");
    expect(prompt).toContain("one concrete error");
    expect(prompt).not.toContain(RESULT_TOOL_NAME);
  });

  test("exposes a provider-safe closed envelope schema", async () => {
    const parameters = (await register()).parameters;
    const validator = Compile(parameters);
    expect(parameters.type).toBe("object");
    expect(Object.keys(parameters.properties)).toEqual(["result", "error"]);
    expect(validator.Check({ result: "report" })).toBe(true);
    expect(validator.Check({ result: { report: true } })).toBe(false);
    expect(validator.Check({ error: { reason: "blocked" } })).toBe(true);
    expect(validator.Check({ error: { reason: "" } })).toBe(false);
    // Provider-safe schemas expose both alternatives as optional properties;
    // execute() enforces that exactly one was supplied.
    expect(validator.Check({})).toBe(true);
    expect(
      validator.Check({ result: "report", error: { reason: "blocked" } }),
    ).toBe(true);
    expect(validator.Check({ result: "report", extra: true })).toBe(false);
  });

  test("survives Anthropic's real tool-schema translation", async () => {
    const tool = await register();
    const model: Model<"anthropic-messages"> = {
      id: "claude-test",
      name: "Claude Test",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 1_000,
    };
    let payload: unknown;
    const events = streamAnthropic(
      model,
      {
        messages: [{ role: "user", content: "Submit.", timestamp: 0 }],
        tools: [tool],
      },
      {
        client: {} as never,
        onPayload(value) {
          payload = value;
          throw new Error("captured provider payload");
        },
      },
    );
    for await (const _event of events) {
      // Drain the stream after the intentional onPayload error.
    }

    const translated = payload as {
      tools: Array<{
        input_schema: {
          type: string;
          properties: Record<string, unknown>;
          required: string[];
        };
      }>;
    };
    expect(translated.tools[0]?.input_schema.type).toBe("object");
    expect(
      Object.keys(translated.tools[0]?.input_schema.properties ?? {}),
    ).toEqual(["result", "error"]);
  });

  test("wires a concrete payload schema into result", async () => {
    const validator = Compile(
      (
        await register({
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        })
      ).parameters,
    );
    expect(validator.Check({ result: { ok: true } })).toBe(true);
    expect(validator.Check({ result: { ok: "yes" } })).toBe(false);
    expect(validator.Check({ error: { reason: "blocked" } })).toBe(true);
  });

  test("returns accepted result and error envelopes", async () => {
    const tool = await register();
    await expect(
      tool.execute("result-call", { result: "report" }),
    ).resolves.toMatchObject({
      details: { result: "report" },
      terminate: true,
    });
    await expect(
      tool.execute("error-call", { error: { reason: "blocked" } }),
    ).resolves.toMatchObject({
      details: { error: { reason: "blocked" } },
      terminate: true,
    });
    await expect(tool.execute("empty-call", {})).rejects.toThrow(
      "exactly one of 'result' or 'error'",
    );
    await expect(
      tool.execute("ambiguous-call", {
        result: "report",
        error: { reason: "blocked" },
      }),
    ).rejects.toThrow("exactly one of 'result' or 'error'");
  });
});

describe("attach-hold gating", () => {
  test("defers submission while the hold file exists", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-hold-"));
    const holdFile = path.join(dir, "attach-hold");
    fs.writeFileSync(holdFile, "1");
    try {
      const state = harness();
      await state.configure(configuration({ type: "string" }, holdFile));
      const tool = state.tool();
      await expect(
        tool.execute("held-call", { result: "done" }),
      ).rejects.toThrow("not visible as an assistant reply");
      fs.rmSync(holdFile, { force: true });
      const accepted = await tool.execute("free-call", { result: "done" });
      expect(accepted.details).toEqual({ result: "done" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
