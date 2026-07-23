/** Safe publication of live run events to co-loaded pi extensions. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  PROTOCOL_VERSION,
  READY_CHANNEL,
  type ReadyEnvelope,
  RUN_EVENT_CHANNEL,
  type RunEventEnvelope,
} from "../api.js";
import type { RunEvent } from "./events.js";

/**
 * Create the external event sink. The snapshot prevents subscribers from
 * mutating the event objects retained by RunManager state.
 */
export function createRunEventPublisher(
  pi: Pick<ExtensionAPI, "events">,
): (event: RunEvent) => void {
  return (event) => {
    try {
      const snapshot = Object.freeze(structuredClone(event));
      const envelope: RunEventEnvelope = Object.freeze({
        protocol: PROTOCOL_VERSION,
        event: snapshot,
      });
      pi.events.emit(RUN_EVENT_CHANNEL, envelope);
    } catch {
      // External publication is best-effort and must never interrupt a run.
    }
  };
}

export function publishReady(
  pi: Pick<ExtensionAPI, "events">,
  version: string,
): void {
  try {
    const envelope: ReadyEnvelope = Object.freeze({
      protocol: PROTOCOL_VERSION,
      version,
    });
    pi.events.emit(READY_CHANNEL, envelope);
  } catch {
    // A broken external bus must not interrupt session initialization.
  }
}
