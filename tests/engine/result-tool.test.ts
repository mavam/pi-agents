import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

  test("enforces the closed result-or-error envelope", () => {
    const validator = Compile(register().parameters);
    expect(validator.Check({ result: "report" })).toBe(true);
    expect(validator.Check({ result: { report: true } })).toBe(false);
    expect(validator.Check({ error: { reason: "blocked" } })).toBe(true);
    expect(validator.Check({ error: { reason: "" } })).toBe(false);
    expect(validator.Check({})).toBe(false);
    expect(
      validator.Check({ result: "report", error: { reason: "blocked" } }),
    ).toBe(false);
    expect(validator.Check({ result: "report", extra: true })).toBe(false);
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
