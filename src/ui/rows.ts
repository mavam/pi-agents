/**
 * Rows of the panel and of `/agents`: groups and standalone agents, each
 * group followed by its agents.
 */

import type { AgentInfo, GroupInfo } from "../agents/types.js";

export type Row =
  | { kind: "group"; key: string; group: GroupInfo }
  | { kind: "agent"; key: string; agent: AgentInfo; nested: boolean };

export interface RowSource {
  /** Candidate standalone agents. */
  agents: readonly AgentInfo[];
  groups: readonly GroupInfo[];
  /** A group's agent by ID. */
  agent: (id: string) => AgentInfo | undefined;
}

type Entry =
  | { kind: "group"; info: GroupInfo }
  | { kind: "agent"; info: AgentInfo };

export type EntryOrder = (
  left: Pick<AgentInfo, "state" | "createdAt" | "closed">,
  right: Pick<AgentInfo, "state" | "createdAt" | "closed">,
) => number;

/**
 * Groups and the agents outside them in `order`; a group is followed by its
 * agents in spawn order when `expand` says so. An agent whose group is not
 * among `groups` stands alone.
 */
export function buildRows(
  source: RowSource,
  order: EntryOrder,
  expand: (group: GroupInfo) => boolean,
): Row[] {
  const groupIds = new Set(source.groups.map((group) => group.id));
  const entries: Entry[] = [
    ...source.groups.map((info) => ({ kind: "group" as const, info })),
    ...source.agents
      .filter((info) => info.group === undefined || !groupIds.has(info.group))
      .map((info) => ({ kind: "agent" as const, info })),
  ].sort((left, right) => order(left.info, right.info));
  return entries.flatMap((entry): Row[] => {
    if (entry.kind === "agent")
      return [
        {
          kind: "agent",
          key: `agent:${entry.info.id}`,
          agent: entry.info,
          nested: false,
        },
      ];
    const group = entry.info;
    const head: Row = { kind: "group", key: `group:${group.id}`, group };
    if (!expand(group)) return [head];
    return [
      head,
      ...group.members.flatMap((member): Row[] => {
        const agent = source.agent(member.agentId);
        return agent
          ? [{ kind: "agent", key: `agent:${agent.id}`, agent, nested: true }]
          : [];
      }),
    ];
  });
}

/** The agent a row attaches to: the agent, or a group's first agent. */
export function attachTarget(row: Row): string | undefined {
  return row.kind === "agent" ? row.agent.id : row.group.members[0]?.agentId;
}
