/**
 * A Pi process that dies while an agent's failed job drains the group its
 * failed run spawned, after a retry spawned another group, in the store
 * at `argv[2]`.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { GraphsDoc } from "../../src/agents/records.js";
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

let aborted = false;
const models = fauxModels(async (context, request) => {
  const prompt = lastUserText(context);
  if (prompt.startsWith("hold")) {
    await heldUntilAborted(request?.signal);
    aborted = true;
    // Cleanup outlasts the process.
    await new Promise(() => {});
  }
  const failing = prompt === "fail";
  if (context.messages.at(-1)?.role === "toolResult")
    return failing
      ? fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "job failed",
        })
      : fauxAssistantMessage("checking");
  const name = failing ? "original" : "retry";
  return fauxAssistantMessage(
    [fauxToolCall("agent_spawn", { agents: [{ name, job: "hold" }] })],
    { stopReason: "toolUse" },
  );
});

const service = await openService({
  storage: await jsonlStorage(process.argv[2] as string),
  models,
  settings: { retry: { enabled: false } },
});
await service.spawnGraph({
  agents: [{ name: "lead", job: "fail", cwd: ".", model: MODEL, spawn: true }],
});
await until(() => aborted);
await service.prompt("lead", "retry", "auto");
const harness = hostOf(service).harness.harness;
await until(async () => {
  const graphs = await harness.snapshot(GraphsDoc, BACKGROUND_CONTEXT);
  return Object.values(graphs?.graphs ?? {}).some(
    (graph) => graph.name === "lead.retry",
  );
});
process.exit(0);
