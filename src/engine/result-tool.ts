import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ResultMode } from "./types.js";

export const RESULT_TOOL_NAME = "pi_agents_submit_result";
export const RESULT_MODE_ENV_VAR = "PI_AGENTS_RESULT_MODE";

function resultMode(): ResultMode {
  const value = process.env[RESULT_MODE_ENV_VAR];
  if (value === "text" || value === "json") return value;
  throw new Error(
    `${RESULT_MODE_ENV_VAR} must be set to either 'text' or 'json'`,
  );
}

export default function resultToolExtension(pi: ExtensionAPI): void {
  const mode = resultMode();
  const valueDescription =
    mode === "text"
      ? "The complete textual result, including any Markdown."
      : "The complete JSON result.";
  const valueSchema =
    mode === "text"
      ? Type.String({ description: valueDescription })
      : Type.Unknown({ description: valueDescription });

  pi.registerTool(
    defineTool({
      name: RESULT_TOOL_NAME,
      label: "Submit Agent Result",
      description:
        "Submit the complete result of this delegated assignment. This is " +
        "the only way to complete the assignment successfully. An accepted " +
        "submission becomes the workflow value and ends the agent.",
      promptSnippet: "Submit the complete agent result as the final action",
      promptGuidelines: [
        "Submit exactly one complete agent result as your final action.",
        "Assistant messages are progress only and are not returned as the result.",
        "If a submission is rejected, correct it and submit again.",
        mode === "text"
          ? "Submit the complete text or Markdown result as a string."
          : "Submit the complete machine-readable result as a JSON value.",
      ],
      parameters: Type.Object(
        { value: valueSchema },
        { additionalProperties: false },
      ),

      async execute(_toolCallId, params) {
        return {
          content: [{ type: "text", text: "Agent result accepted." }],
          details: { value: params.value },
          terminate: true,
        };
      },
    }),
  );
}
