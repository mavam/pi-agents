/**
 * Version of the pi-agents event-bus and persisted run-event envelope.
 *
 * A breaking change rejects envelopes from every other version.
 */
export const PROTOCOL_VERSION = 2 as const;
