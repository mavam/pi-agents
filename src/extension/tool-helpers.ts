import type { Scope } from "../catalog/agents.js";
import type {
  AgentRunDetails,
  RunNode,
  RunResultDetails,
  WorkflowParams,
} from "../runtime/types.js";
import { summarizeWorkflowOutput } from "../ui/presentation.js";

export function initialAgentDetails(
  scope: Scope,
  agent: string,
): AgentRunDetails {
  return {
    agent,
    agentSource: "unknown",
    skills: [],
    missingSkills: [],
    exitCode: 1,
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
    discoveryDiagnostics: [],
    scope,
  };
}

export function formatBackgroundContinuationText(runId: string): string {
  return `Flow is running in background: ${runId}\nStanding by for results. Use \`/flow watch ${runId}\`, \`/flow ${runId}\`, or \`/flow stop ${runId}\`.`;
}

export function summarizeFinalNotification(
  result: RunResultDetails["result"],
): string | undefined {
  if (!result) return undefined;
  if (result.kind === "sequence" && result.steps.length > 1) {
    return undefined;
  }
  return summarizeWorkflowOutput(result.output);
}

export function isSingleSpawnFlow(flow: WorkflowParams["flow"]): boolean {
  return (
    flow.kind === "spawn" ||
    (flow.kind === "sequence" &&
      flow.steps.length === 1 &&
      flow.steps[0]?.kind === "spawn")
  );
}

function previewLine(text: string | undefined, max = 120): string | undefined {
  if (!text) return undefined;
  const line = text
    .split("\n")
    .map((entry) => entry.trim())
    .find(Boolean);
  if (!line) return undefined;
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

export function getRootRunNode(details: RunResultDetails): RunNode | undefined {
  return details.nodes.find((node) => node.id === details.run.rootNodeId);
}

export function mergeAgentProgressDetails(
  details: RunResultDetails,
  base: AgentRunDetails,
): AgentRunDetails {
  const rootNode = getRootRunNode(details);
  const progressDetails = rootNode?.progress?.details;
  return {
    ...base,
    ...progressDetails,
    status:
      details.run.status === "running"
        ? "running"
        : details.run.status === "completed"
          ? "completed"
          : "stopped",
    startedAt: details.run.startedAt,
    completedAt: details.run.completedAt,
    preview:
      rootNode?.progress?.preview ??
      progressDetails?.preview ??
      previewLine(rootNode?.progress?.text) ??
      previewLine(
        typeof details.result?.output === "string"
          ? details.result.output
          : undefined,
      ),
  };
}

export function formatWorkflowProgressText(snapshot: RunResultDetails): string {
  if (snapshot.run.status !== "running") {
    return (
      summarizeFinalNotification(snapshot.result) ??
      snapshot.run.error ??
      snapshot.run.label
    );
  }
  const running = snapshot.nodes.filter(
    (node) => node.status === "running",
  ).length;
  const waiting = snapshot.nodes.filter(
    (node) => node.status === "waiting",
  ).length;
  const parts = [
    running > 0 ? `${running} running` : undefined,
    waiting > 0 ? `${waiting} waiting` : undefined,
  ].filter(Boolean);
  return parts.join(" · ") || snapshot.run.label;
}
