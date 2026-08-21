import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Compile } from "typebox/compile";
import resultToolExtension, {
  RESULT_SCHEMA_FILE_ENV_VAR,
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

const originalSchemaFile = process.env[RESULT_SCHEMA_FILE_ENV_VAR];
const tempDirs: string[] = [];

afterEach(() => {
  if (originalSchemaFile === undefined)
    delete process.env[RESULT_SCHEMA_FILE_ENV_VAR];
  else process.env[RESULT_SCHEMA_FILE_ENV_VAR] = originalSchemaFile;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function schemaFile(schema: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-tool-test-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, "schema.json");
  fs.writeFileSync(filePath, JSON.stringify(schema));
  return filePath;
}

function register(schema: unknown = { type: "string" }): CapturedTool {
  process.env[RESULT_SCHEMA_FILE_ENV_VAR] = schemaFile(schema);
  let captured: CapturedTool | undefined;
  const pi = {
    registerTool(tool: CapturedTool) {
      captured = tool;
    },
  } as unknown as ExtensionAPI;
  resultToolExtension(pi);
  if (!captured) throw new Error("result tool was not registered");
  return captured;
}

describe("agent result tool", () => {
  test("describes semantic submission without prompt-name coupling", () => {
    const tool = register();
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

  test("exposes a provider-safe closed envelope schema", () => {
    const parameters = register().parameters;
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
    const tool = register();
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

  test("wires a concrete payload schema into result", () => {
    const validator = Compile(
      register({
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      }).parameters,
    );
    expect(validator.Check({ result: { ok: true } })).toBe(true);
    expect(validator.Check({ result: { ok: "yes" } })).toBe(false);
    expect(validator.Check({ error: { reason: "blocked" } })).toBe(true);
  });

  test("returns accepted result and error envelopes", async () => {
    const tool = register();
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

  test("refuses to load without a schema file variable", () => {
    delete process.env[RESULT_SCHEMA_FILE_ENV_VAR];
    expect(() =>
      resultToolExtension({ registerTool() {} } as unknown as ExtensionAPI),
    ).toThrow(RESULT_SCHEMA_FILE_ENV_VAR);
  });

  test("refuses unreadable, unparsable, and invalid schema files", () => {
    process.env[RESULT_SCHEMA_FILE_ENV_VAR] = "/missing/result-schema.json";
    expect(() =>
      resultToolExtension({ registerTool() {} } as unknown as ExtensionAPI),
    ).toThrow("Could not read");

    const filePath = schemaFile({ type: "string" });
    fs.writeFileSync(filePath, "not JSON");
    process.env[RESULT_SCHEMA_FILE_ENV_VAR] = filePath;
    expect(() =>
      resultToolExtension({ registerTool() {} } as unknown as ExtensionAPI),
    ).toThrow("Could not parse");

    process.env[RESULT_SCHEMA_FILE_ENV_VAR] = schemaFile({ type: "bogus" });
    expect(() =>
      resultToolExtension({ registerTool() {} } as unknown as ExtensionAPI),
    ).toThrow("Invalid result schema");
  });
});

describe("attach-hold gating", () => {
  test("defers submission while the hold file exists", async () => {
    const holdFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-hold-")),
      "attach-hold",
    );
    fs.writeFileSync(holdFile, "1");
    process.env.PI_AGENTS_ATTACH_HOLD_FILE = holdFile;
    try {
      const tool = register();
      await expect(
        tool.execute("held-call", { result: "done" }),
      ).rejects.toThrow("Submission deferred");
      fs.rmSync(holdFile, { force: true });
      const accepted = await tool.execute("free-call", { result: "done" });
      expect(accepted.details).toEqual({ result: "done" });
    } finally {
      delete process.env.PI_AGENTS_ATTACH_HOLD_FILE;
      fs.rmSync(path.dirname(holdFile), { recursive: true, force: true });
    }
  });
});
