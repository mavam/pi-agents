/**
 * Shared background context and durable IDs for the agent collaborators.
 */

import type { Context } from "@earendil-works/chord";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";

export const CONTEXT = BACKGROUND_CONTEXT;

export function conversationId(agentId: string): ConversationId {
  return Number(agentId) as ConversationId;
}

export function taskId(id: string | number): TaskId {
  return Number(id) as TaskId;
}

export function contextFor(signal: AbortSignal | undefined): Context {
  return signal ? withAbortSignal(signal, CONTEXT) : CONTEXT;
}
