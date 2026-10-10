/**
 * Agent and graph results posted into the parent conversation: the
 * model-facing text and the TUI cards.
 */

import {
  type ExtensionAPI,
  getMarkdownTheme,
  type MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import {
  graphReport,
  type NodeKind,
  nodeCounts,
  nodeNote,
  nodeResult,
  type ReportNode,
  truncateResult,
} from "../agents/report.js";
import type {
  AgentDelivery,
  AgentInfo,
  AgentState,
  GraphNode,
  GraphPolicy,
} from "../agents/types.js";
import {
  type Colorize,
  formatUsage,
  plainColorize,
  STATE_STYLES,
  shortModel,
} from "../ui/format.js";

export const RESULT_MESSAGE = "pi-agents:result";
export const GRAPH_RESULT_MESSAGE = "pi-agents:graph-result";

/** Lines of a collapsed result body. */
const COLLAPSED_LINES = 12;
/** Lines of each agent's collapsed result in a graph card. */
const COLLAPSED_NODE_LINES = 6;

export type { NodeKind };
export { nodeCounts, truncateResult };

export interface ResultDetails {
  version: 1;
  agentId: string;
  name: string;
  kind: "answered" | "failed";
  /** The result text, or the failure reason. */
  body: string;
  profile?: string;
  model?: string;
  usage?: string;
  /** The delivery this message carries; absent in messages of earlier
   * versions. */
  delivery?: string;
}

function isResultDetails(value: unknown): value is ResultDetails {
  if (typeof value !== "object" || value === null) return false;
  const details = value as Record<string, unknown>;
  return (
    details.version === 1 &&
    typeof details.agentId === "string" &&
    typeof details.name === "string" &&
    (details.kind === "answered" || details.kind === "failed") &&
    typeof details.body === "string"
  );
}

export function resultDetails(
  delivery: AgentDelivery,
  info: AgentInfo | undefined,
): ResultDetails {
  const { outcome } = delivery;
  const usage = info ? formatUsage(info.usage) : "";
  return {
    version: 1,
    agentId: delivery.agentId,
    name: delivery.name,
    kind:
      outcome.kind === "answered" && outcome.result.stopReason !== "error"
        ? "answered"
        : "failed",
    body:
      outcome.kind === "answered"
        ? outcome.result.stopReason === "error"
          ? (outcome.result.errorMessage ?? (outcome.result.text || "error"))
          : outcome.result.text
        : outcome.reason,
    ...(info?.profile ? { profile: info.profile } : {}),
    ...(info ? { model: shortModel(info) } : {}),
    ...(usage ? { usage } : {}),
  };
}

/** What the parent model reads. */
export function resultContent(details: ResultDetails): string {
  return details.kind === "answered"
    ? `Agent ${details.name} answered:\n\n${details.body || "(empty)"}`
    : `Agent ${details.name} failed: ${details.body}`;
}

function resultHeader(
  details: ResultDetails,
  color: Colorize = plainColorize,
): string {
  const style =
    details.kind === "answered" ? STATE_STYLES.idle : STATE_STYLES.failed;
  const meta = [details.profile, details.model, details.usage]
    .filter(Boolean)
    .join(" · ");
  return `${color(style.color, style.icon)} ${details.name} ${details.kind === "answered" ? "answered" : "failed"}${meta ? color("dim", ` · ${meta}`) : ""}`;
}

function collapse(body: string, expanded: boolean): string {
  if (expanded) return body;
  const lines = body.split("\n");
  if (lines.length <= COLLAPSED_LINES) return body;
  return `${lines.slice(0, COLLAPSED_LINES).join("\n")}\n\n… ${lines.length - COLLAPSED_LINES} more lines`;
}

export interface NodeDetails extends ReportNode {
  agentId: string;
  /** Names of the agents whose results it received. */
  inputs: string[];
  profile?: string;
  model?: string;
  usage?: string;
}

export interface GraphResultDetails {
  version: 1;
  graphId: string;
  name: string;
  policy: GraphPolicy;
  nodes: NodeDetails[];
  /** The delivery this message carries; absent in messages of earlier
   * versions and outside messages. */
  delivery?: string;
}

function isGraphResultDetails(value: unknown): value is GraphResultDetails {
  if (typeof value !== "object" || value === null) return false;
  const details = value as Record<string, unknown>;
  return (
    details.version === 1 &&
    typeof details.graphId === "string" &&
    typeof details.name === "string" &&
    Array.isArray(details.nodes)
  );
}

export function nodeDetails(
  node: GraphNode,
  info: AgentInfo | undefined,
  names: ReadonlyMap<string, string>,
): NodeDetails {
  const usage = info ? formatUsage(info.usage) : "";
  const { kind, body } = nodeResult(node, info?.state);
  return {
    agentId: node.agentId,
    name: node.name,
    kind,
    body,
    end: node.end,
    inputs: node.inputs.map((input) => names.get(input) ?? input),
    ...(info?.profile ? { profile: info.profile } : {}),
    ...(info ? { model: shortModel(info) } : {}),
    ...(usage ? { usage } : {}),
  };
}

export function graphResultDetails(
  graph: { id: string; name: string; policy: GraphPolicy },
  nodes: readonly GraphNode[],
  lookup: (agentId: string) => AgentInfo | undefined,
): GraphResultDetails {
  const names = new Map(nodes.map((node) => [node.agentId, node.name]));
  return {
    version: 1,
    graphId: graph.id,
    name: graph.name,
    policy: graph.policy,
    nodes: nodes.map((node) => nodeDetails(node, lookup(node.agentId), names)),
  };
}

/** What the parent model reads for a finished graph. */
export function graphContent(details: GraphResultDetails): string {
  return graphReport(details.name, details.nodes);
}

/** The agents that are not end nodes and did not answer. */
function problems(details: GraphResultDetails): NodeDetails[] {
  return details.nodes.filter((node) => !node.end && node.kind !== "answered");
}

const KIND_STATES: Record<NodeKind, AgentState> = {
  answered: "idle",
  failed: "failed",
  interrupted: "interrupted",
  stopped: "interrupted",
  skipped: "skipped",
  working: "working",
  waiting: "waiting",
};

function graphState(ends: readonly NodeDetails[]): AgentState {
  const kinds = ends.map((node) => node.kind);
  if (kinds.some((kind) => kind === "failed" || kind === "skipped"))
    return "failed";
  if (kinds.some((kind) => kind !== "answered")) return "interrupted";
  return "idle";
}

function nodeMeta(node: NodeDetails): string {
  return [node.profile, node.model, node.usage].filter(Boolean).join(" · ");
}

function collapseLines(body: string, expanded: boolean, lines: number): string {
  const all = body.split("\n");
  if (expanded || all.length <= lines) return body;
  return `${all.slice(0, lines).join("\n")}\n\n… ${all.length - lines} more lines`;
}

const renderGraphResult: MessageRenderer = (message, options, theme) => {
  const details = message.details;
  if (!isGraphResultDetails(details))
    return renderResult(message, options, theme);
  const color: Colorize = (name, text) => theme.fg(name, text);
  const card = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
  const ends = details.nodes.filter((node) => node.end);
  const [only] = ends;
  const style = STATE_STYLES[graphState(ends)];
  const icon = color(style.color, style.icon);
  const addBody = (node: NodeDetails, lines: number) => {
    if (!node.body) return;
    const body = collapseLines(node.body, options.expanded, lines);
    card.addChild(
      node.kind === "failed"
        ? new Text(color("error", body), 0, 0)
        : new Markdown(body, 0, 0, getMarkdownTheme()),
    );
  };
  if (ends.length === 1 && only) {
    const meta = nodeMeta(only);
    card.addChild(
      new Text(
        `${icon} ${details.name} › ${only.name} ${only.kind}${meta ? color("dim", ` · ${meta}`) : ""}`,
        0,
        0,
      ),
    );
    if (only.body) card.addChild(new Spacer(1));
    addBody(only, COLLAPSED_LINES);
  } else {
    card.addChild(
      new Text(
        `${icon} ${details.name} finished${color("dim", ` · ${nodeCounts(ends).replaceAll(", ", " · ")}`)}`,
        0,
        0,
      ),
    );
    for (const node of ends) {
      const nodeStyle = STATE_STYLES[KIND_STATES[node.kind]];
      const meta = nodeMeta(node);
      card.addChild(new Spacer(1));
      card.addChild(
        new Text(
          `${color(nodeStyle.color, nodeStyle.icon)} ${node.name}${meta ? color("dim", ` · ${meta}`) : ""}`,
          0,
          0,
        ),
      );
      addBody(node, COLLAPSED_NODE_LINES);
    }
  }
  const others = problems(details);
  if (others.length > 0) {
    card.addChild(new Spacer(1));
    card.addChild(
      new Text(
        others
          .map((node) => {
            const nodeStyle = STATE_STYLES[KIND_STATES[node.kind]];
            return `${color(nodeStyle.color, nodeStyle.icon)} ${node.name} ${color(node.kind === "failed" ? "error" : "dim", nodeNote(node))}`;
          })
          .join("\n"),
        0,
        0,
      ),
    );
  }
  return card;
};

const renderResult: MessageRenderer = (message, options, theme) => {
  const details = message.details;
  const color: Colorize = (name, text) => theme.fg(name, text);
  const card = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
  if (!isResultDetails(details)) {
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n");
    card.addChild(new Markdown(text, 0, 0, getMarkdownTheme()));
    return card;
  }
  card.addChild(new Text(resultHeader(details, color), 0, 0));
  if (details.body) {
    card.addChild(new Spacer(1));
    card.addChild(
      details.kind === "answered"
        ? new Markdown(
            collapse(details.body, options.expanded),
            0,
            0,
            getMarkdownTheme(),
          )
        : new Text(color("error", details.body), 0, 0),
    );
  }
  return card;
};

export function registerMessageRenderers(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(RESULT_MESSAGE, renderResult);
  pi.registerMessageRenderer(GRAPH_RESULT_MESSAGE, renderGraphResult);
}
