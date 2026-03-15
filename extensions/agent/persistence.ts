import type {
  CustomEntry,
  ExtensionAPI,
  SessionEntry,
} from "@mariozechner/pi-coding-agent";
import type { CompositionRuntimeState } from "./state.js";
import {
  applyCompositionEvent,
  createCompositionRuntimeState,
} from "./state.js";
import type { CompositionEvent } from "./types.js";

export const COMPOSITION_EVENT_CUSTOM_TYPE = "pi-agents:composition-event";

function isCompositionEventEntry(
  entry: SessionEntry,
): entry is CustomEntry<CompositionEvent> {
  return (
    entry.type === "custom" &&
    entry.customType === COMPOSITION_EVENT_CUSTOM_TYPE &&
    entry.data !== undefined
  );
}

export function appendCompositionEvent(
  pi: ExtensionAPI,
  event: CompositionEvent,
): void {
  pi.appendEntry(COMPOSITION_EVENT_CUSTOM_TYPE, event);
}

export function rebuildCompositionState(
  entries: SessionEntry[],
): CompositionRuntimeState {
  const state = createCompositionRuntimeState();
  for (const entry of entries) {
    if (!isCompositionEventEntry(entry)) continue;
    const event = entry.data;
    if (!event) continue;
    applyCompositionEvent(state, event);
  }
  return state;
}
