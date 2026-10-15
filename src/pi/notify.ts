import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { AgentInfo, GraphInfo } from "../agents/types.js";

/**
 * Show a notice, if Pi has a UI for it. Work can outlive its session, and
 * Pi makes every use of a replaced session's context throw. A notice from
 * such work, often in a promise's error handler, would then turn into an
 * unhandled rejection that ends Pi; it goes nowhere instead.
 */
export function notify(
  ctx: ExtensionContext | undefined,
  text: string,
  type: "info" | "warning" | "error" = "warning",
): void {
  try {
    if (ctx?.hasUI) ctx.ui.notify(text, type);
  } catch {
    // The session was replaced, and its UI with it.
  }
}

/**
 * What switching away from a session pauses: agents that work or wait, and
 * results Pi hasn't taken yet. They stay with the session and continue when
 * it's resumed. Helpers go with the agent that started them.
 */
export function pausedNotice(
  agents: readonly AgentInfo[],
  graphs: readonly GraphInfo[],
): string | undefined {
  const helperGraphs = new Set(
    graphs.filter((graph) => graph.owner).map((graph) => graph.id),
  );
  const names = [
    ...agents
      .filter((agent) => !agent.graph || !helperGraphs.has(agent.graph))
      .filter(
        (agent) =>
          agent.state === "working" ||
          agent.state === "waiting" ||
          agent.queued,
      )
      .map((agent) => agent.name),
    ...graphs
      .filter((graph) => !graph.owner && graph.queued)
      .map((graph) => graph.name),
  ];
  if (names.length === 0) return undefined;
  const [verb, them] = names.length === 1 ? ["is", "it"] : ["are", "them"];
  return `pi-agents: ${names.join(", ")} ${verb} paused with the previous session. Resume that session to continue ${them} and receive results.`;
}

/**
 * Notices for the session that replaces this one. Pi replaces the screen
 * along with the session, so a notice shown while the old session shuts
 * down disappears at once; the new session shows it instead.
 */
function noticeFile(sessionFile: string): string {
  const key = createHash("sha256").update(sessionFile).digest("hex");
  return path.join(getAgentDir(), "pi-agents", "notices", `${key}.txt`);
}

export function leaveNotice(sessionFile: string, text: string): void {
  const file = noticeFile(sessionFile);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** The notice a replaced session left for this one, read once. */
export function takeNotice(sessionFile: string): string | undefined {
  const file = noticeFile(sessionFile);
  try {
    const text = fs.readFileSync(file, "utf8");
    fs.rmSync(file, { force: true });
    return text;
  } catch {
    return undefined;
  }
}
