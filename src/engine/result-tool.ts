import * as fs from "node:fs";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type AgentResultEnvelope,
  buildAgentResultEnvelopeSchema,
  validateJsonSchema,
} from "../model/json-schema.js";

export const RESULT_TOOL_NAME = "pi_agents_submit_result";
export const RESULT_SCHEMA_FILE_ENV_VAR = "PI_AGENTS_RESULT_SCHEMA_FILE";
/** Names a file whose existence defers result submission: while a
 * supervising user is attached, the agent may not terminate. */
export const RESULT_HOLD_FILE_ENV_VAR = "PI_AGENTS_ATTACH_HOLD_FILE";

function resultEnvelope(rawParams: unknown): AgentResultEnvelope {
  if (typeof rawParams !== "object" || rawParams === null) {
    throw new Error("Submit exactly one of 'result' or 'error', then retry.");
  }
  const hasResult = Object.hasOwn(rawParams, "result");
  const hasError = Object.hasOwn(rawParams, "error");
  if (hasResult === hasError) {
    throw new Error("Submit exactly one of 'result' or 'error', then retry.");
  }
  return rawParams as AgentResultEnvelope;
}

function resultSchema() {
  const filePath = process.env[RESULT_SCHEMA_FILE_ENV_VAR];
  if (!filePath) {
    throw new Error(`${RESULT_SCHEMA_FILE_ENV_VAR} must name a schema file`);
  }
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not read ${RESULT_SCHEMA_FILE_ENV_VAR} file '${filePath}': ${message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not parse ${RESULT_SCHEMA_FILE_ENV_VAR} file '${filePath}': ${message}`,
    );
  }
  try {
    return validateJsonSchema(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Invalid result schema in ${RESULT_SCHEMA_FILE_ENV_VAR} file '${filePath}': ${message}`,
    );
  }
}

export default function resultToolExtension(pi: ExtensionAPI): void {
  const parameters = buildAgentResultEnvelopeSchema(resultSchema());

  pi.registerTool(
    defineTool({
      name: RESULT_TOOL_NAME,
      label: "Submit Agent Result",
      description:
        "Submit the complete result of this delegated assignment, or report " +
        "that the assignment cannot be completed. This is the only way to " +
        "finish the assignment. An accepted submission ends the agent.",
      promptSnippet: "Submit the complete agent result as the final action",
      promptGuidelines: [
        "Submit exactly one complete result or one concrete error as your final action.",
        "Use result for the assignment's complete deliverable.",
        "Use error only when the assignment cannot be completed; explain the blocker in reason.",
        "Assistant messages are progress only and are not returned as the result.",
        "If a submission is rejected, correct it and submit again.",
      ],
      parameters,

      async execute(_toolCallId, rawParams) {
        // While a supervising user is attached, the agent may not terminate:
        // the engine materializes a hold file for the attachment's lifetime,
        // and the thrown tool error sends the model back to the conversation.
        const holdFile = process.env[RESULT_HOLD_FILE_ENV_VAR];
        if (holdFile && fs.existsSync(holdFile)) {
          throw new Error(
            "Submission deferred: a supervising user is attached to this " +
              "session. Your previous message is already visible to them — " +
              "do not repeat it and do not call this tool again now. Simply " +
              "end your turn and wait for their next message; submit once " +
              "they detach.",
          );
        }
        // Provider adapters such as Anthropic preserve top-level properties
        // but cannot express the exclusive choice. A thrown tool error is
        // returned to the model so it can correct and resubmit the envelope.
        const envelope = resultEnvelope(rawParams);
        const isError = "error" in envelope;
        return {
          content: [
            {
              type: "text",
              text: isError
                ? "Agent error accepted."
                : "Agent result accepted.",
            },
          ],
          details: envelope,
          terminate: true,
        };
      },
    }),
  );
}
