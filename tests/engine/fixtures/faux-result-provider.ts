import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RESULT_TOOL_NAME } from "../../../src/engine/result-tool.js";

export default function fauxResultProvider(pi: ExtensionAPI): void {
  const faux = fauxProvider();
  const accepted = fauxAssistantMessage(
    fauxToolCall(RESULT_TOOL_NAME, {
      result: { source: "real-rpc", ok: true },
    }),
    { stopReason: "toolUse" },
  );
  const error = fauxAssistantMessage(
    fauxToolCall(RESULT_TOOL_NAME, {
      error: { reason: "fixture cannot complete" },
    }),
    { stopReason: "toolUse" },
  );
  const ambiguous = fauxAssistantMessage(
    fauxToolCall(RESULT_TOOL_NAME, {
      result: { source: "ambiguous", ok: false },
      error: { reason: "also an error" },
    }),
    { stopReason: "toolUse" },
  );
  const responses =
    process.env.PI_AGENTS_FAUX_ERROR === "1"
      ? [error]
      : process.env.PI_AGENTS_FAUX_AMBIGUOUS_FIRST === "1"
        ? [ambiguous, accepted]
        : process.env.PI_AGENTS_FAUX_INVALID_FIRST === "1"
          ? [
              fauxAssistantMessage(
                fauxToolCall(RESULT_TOOL_NAME, {
                  result: { source: 1, ok: "yes" },
                }),
                { stopReason: "toolUse" },
              ),
              accepted,
            ]
          : [accepted];
  faux.setResponses(responses);
  pi.registerProvider(faux.provider);
}
