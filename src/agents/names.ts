/**
 * Names of agents and graphs. Names are unique among visible agents and
 * graphs. Every creation claims its names inside its creating commit, against
 * the durable records, so concurrent creations cannot both take a name.
 */

import type { AgentsState, GraphsState } from "./records.js";
import { AgentError } from "./types.js";

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;
/** Longest base for generated names, leaving room for a `-<n>` suffix. */
export const NAME_BASE_LENGTH = 44;

export type Noun = "agent" | "graph";

export function isValidName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

export function invalidName(name: string, noun: Noun): AgentError {
  return new AgentError(
    `Invalid ${noun} name "${name}": use letters, digits, '.', '_', or '-' (at most 48 characters)`,
  );
}

/**
 * Names taken by open records, plus `extra`, such as closed agents that work
 * again, which only the service's derived state knows.
 */
export function takenNames(
  agents: Pick<AgentsState, "agents"> | undefined,
  graphs: Pick<GraphsState, "graphs"> | undefined,
  extra: Iterable<string> = [],
): Set<string> {
  const taken = new Set(extra);
  for (const record of Object.values(agents?.agents ?? {}))
    if (!record.closed) taken.add(record.name);
  for (const record of Object.values(graphs?.graphs ?? {}))
    if (!record.closed) taken.add(record.name);
  return taken;
}

/**
 * Validate and reserve a requested name, or generate one from `base`: the
 * base itself, else `<base>-2`, `<base>-3`, and so on.
 */
export function claimName(
  requested: string | undefined,
  base: string,
  taken: Set<string>,
  noun: Noun,
): string {
  const wanted = requested?.trim();
  let name: string;
  if (wanted) {
    if (!isValidName(wanted)) throw invalidName(wanted, noun);
    if (taken.has(wanted))
      throw new AgentError(
        `An ${noun === "agent" ? "agent" : "agent or graph"} named ${wanted} already exists`,
      );
    name = wanted;
  } else {
    const stem = isValidName(base) ? base.slice(0, NAME_BASE_LENGTH) : noun;
    name = stem;
    for (let index = 2; taken.has(name); index++) name = `${stem}-${index}`;
  }
  taken.add(name);
  return name;
}
