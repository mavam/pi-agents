import type {
  CustomEntry,
  ExtensionAPI,
  SessionEntry,
} from "@mariozechner/pi-coding-agent";
import { applyRunEvent, createRunRuntimeState } from "./state.js";
import type { RunEvent } from "./types.js";

export const RUN_EVENT_CUSTOM_TYPE = "pi-agents:run-event";

function isRunEventEntry(entry: SessionEntry): entry is CustomEntry<RunEvent> {
  return (
    entry.type === "custom" &&
    entry.customType === RUN_EVENT_CUSTOM_TYPE &&
    entry.data !== undefined
  );
}

export function appendRunEvent(pi: ExtensionAPI, event: RunEvent): void {
  pi.appendEntry(RUN_EVENT_CUSTOM_TYPE, event);
}

export function rebuildRunState(entries: SessionEntry[]) {
  const state = createRunRuntimeState();
  for (const entry of entries) {
    if (!isRunEventEntry(entry)) continue;
    const event = entry.data;
    if (!event) continue;
    applyRunEvent(state, event);
  }
  return state;
}
