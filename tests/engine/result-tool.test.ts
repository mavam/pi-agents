import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import resultToolExtension, {
  RESULT_MODE_ENV_VAR,
  RESULT_TOOL_NAME,
} from "../../src/engine/result-tool.js";

interface CapturedTool {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: {
    required?: string[];
    additionalProperties?: boolean;
    properties?: { value?: { type?: string } };
  };
  execute(
    toolCallId: string,
    params: { value: unknown },
  ): Promise<{
    details?: { value?: unknown };
    terminate?: boolean;
  }>;
}

const originalMode = process.env[RESULT_MODE_ENV_VAR];

afterEach(() => {
  if (originalMode === undefined) delete process.env[RESULT_MODE_ENV_VAR];
  else process.env[RESULT_MODE_ENV_VAR] = originalMode;
});

function register(mode: "text" | "json"): CapturedTool {
  process.env[RESULT_MODE_ENV_VAR] = mode;
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
  test("describes semantic result submission without prompt-name coupling", () => {
    const tool = register("text");
    expect(tool.name).toBe(RESULT_TOOL_NAME);
    expect(tool.label).toBe("Submit Agent Result");
    expect(tool.description).toContain(
      "Submit the complete result of this delegated assignment",
    );
    const prompt = [tool.promptSnippet, ...(tool.promptGuidelines ?? [])].join(
      "\n",
    );
    expect(prompt).toContain("complete agent result");
    expect(prompt).not.toContain(RESULT_TOOL_NAME);
  });

  test("requires a string value for text results", async () => {
    const tool = register("text");
    expect(tool.parameters.required).toEqual(["value"]);
    expect(tool.parameters.additionalProperties).toBe(false);
    expect(tool.parameters.properties?.value?.type).toBe("string");
    await expect(
      tool.execute("call", { value: "report" }),
    ).resolves.toMatchObject({
      details: { value: "report" },
      terminate: true,
    });
  });

  test("accepts unrestricted JSON values for JSON results", async () => {
    const tool = register("json");
    expect(tool.parameters.properties?.value?.type).toBeUndefined();
    await expect(tool.execute("call", { value: null })).resolves.toMatchObject({
      details: { value: null },
      terminate: true,
    });
  });

  test("refuses to load without a result mode", () => {
    delete process.env[RESULT_MODE_ENV_VAR];
    expect(() =>
      resultToolExtension({ registerTool() {} } as unknown as ExtensionAPI),
    ).toThrow(RESULT_MODE_ENV_VAR);
  });
});
