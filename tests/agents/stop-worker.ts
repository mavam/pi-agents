/**
 * A Pi process that dies while stopping an agent: in the store at
 * `argv[2]`, an agent spawns two working children, Pi stops the agent, and
 * the process exits at the stop's first commit, before the stop can finish.
 */

import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  fauxModels,
  heldUntilAborted,
  hostOf,
  jsonlStorage,
  lastUserText,
  MODEL,
  openService,
  until,
} from "./helpers.js";

const models = fauxModels(async (context, request) => {
  const last = context.messages.at(-1);
  if (last?.role === "toolResult") return fauxAssistantMessage("checking");
  const prompt = lastUserText(context);
  if (prompt === "hold") await heldUntilAborted(request?.signal);
  if (prompt.includes("spawn"))
    return fauxAssistantMessage(
      [
        fauxToolCall("agent_spawn", {
          agents: [
            { name: "c", job: "hold" },
            { name: "d", job: "hold" },
          ],
        }),
      ],
      { stopReason: "toolUse" },
    );
  return fauxAssistantMessage(`done: ${prompt}`);
});

const directory = process.argv[2] as string;
const service = await openService({
  storage: await jsonlStorage(directory),
  models,
});
await service.spawnGraph({
  agents: [
    { name: "victim", job: "spawn", cwd: ".", model: MODEL, spawn: true },
  ],
});
await until(() =>
  ["victim.c", "victim.d"].every(
    (name) => service.get(name)?.state === "working",
  ),
);
let stopping = false;
hostOf(service).harness.harness.subscribeCommits((publication) => {
  if (
    stopping &&
    publication.changes.some(
      (change) =>
        change.type === "document" &&
        (change.record.kind === "pi-agents.agents" ||
          change.record.kind === "pi-agents.graphs"),
    )
  )
    process.exit(0);
});
stopping = true;
await service.stop("victim");
