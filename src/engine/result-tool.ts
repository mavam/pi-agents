/**
 * Static extension loaded into every delegated `pi --mode rpc` child. At load
 * time it only registers the internal configuration command; the parent
 * invokes that command over the RPC prompt channel before the first task
 * prompt, which registers and activates the concrete result-submission tool.
 */

import * as fs from "node:fs";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type AgentResultEnvelope,
  buildAgentResultEnvelopeSchema,
} from "../model/json-schema.js";
import {
  CONFIGURE_RESULT_COMMAND,
  decodeResultToolConfiguration,
  RESULT_TOOL_NAME,
  type ResultToolConfiguration,
} from "./result-protocol.js";

export {
  CONFIGURE_RESULT_COMMAND,
  RESULT_TOOL_NAME,
} from "./result-protocol.js";

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

function registerResultTool(
  pi: ExtensionAPI,
  config: ResultToolConfiguration,
): void {
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
      parameters: buildAgentResultEnvelopeSchema(config.resultSchema),

      async execute(_toolCallId, rawParams) {
        // While a supervising user is attached, the agent may not terminate:
        // the engine materializes a hold file for the attachment's lifetime,
        // and the thrown tool error sends the model back to the conversation.
        if (fs.existsSync(config.holdFile)) {
          throw new Error(
            "Submission deferred: a supervising user is attached to this " +
              "session. This tool call is not visible as an assistant reply. " +
              "If you have not answered their latest message in assistant " +
              "text during this turn, do that now. Do not call this tool " +
              "again until they detach; after replying, end your turn and " +
              "wait for their next message.",
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

export default function resultToolExtension(pi: ExtensionAPI): void {
  let configured = false;

  pi.registerCommand(CONFIGURE_RESULT_COMMAND, {
    description: "Internal pi-agents result-tool configuration",
    handler: async (args) => {
      // Failures throw: Pi reports them as `extension_error` events on the
      // RPC stream, which the parent treats as a fatal protocol failure.
      if (configured) {
        throw new Error("The agent result tool is already configured");
      }
      const config = decodeResultToolConfiguration(args);
      registerResultTool(pi, config);
      // `--tools` allowlists auto-activate the freshly registered tool; an
      // open toolset needs the explicit union.
      pi.setActiveTools([
        ...new Set([...pi.getActiveTools(), RESULT_TOOL_NAME]),
      ]);
      configured = true;
    },
  });
}
