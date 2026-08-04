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
      value: { source: "real-rpc", ok: true },
    }),
    { stopReason: "toolUse" },
  );
  const responses =
    process.env.PI_AGENTS_FAUX_INVALID_FIRST === "1"
      ? [
          fauxAssistantMessage(fauxToolCall(RESULT_TOOL_NAME, {}), {
            stopReason: "toolUse",
          }),
          accepted,
        ]
      : [accepted];
  faux.setResponses(responses);
  pi.registerProvider(faux.provider);
}
