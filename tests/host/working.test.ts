import { afterEach, describe, expect, test } from "bun:test";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { AgentService } from "../../src/agents/service.js";
import { readWorkingLimit } from "../../src/host/working.js";
import {
  briefly,
  closeService,
  createGatedFaux,
  hostOf,
  MODEL,
  openService,
  until,
} from "../agents/helpers.js";

/**
 * A faux model that records which agent each request comes from and how many
 * run at once. `bash <command>` calls bash, `spawn <json>` spawns, and
 * a tool result or another prompt is answered after a moment.
 */
function recording() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const stats = { active: 0, peak: 0, sessions: [] as string[] };
  const step: FauxResponseStep = async (context, options) => {
    stats.active += 1;
    stats.peak = Math.max(stats.peak, stats.active);
    stats.sessions.push(options?.sessionId ?? "");
    try {
      await briefly(options?.signal, 20);
      const last = context.messages.at(-1);
      if (last?.role === "toolResult") {
        if (last.toolName === "agent_spawn")
          return fauxAssistantMessage([fauxToolCall("agent_wait", {})], {
            stopReason: "toolUse",
          });
        return fauxAssistantMessage([fauxText("merged")]);
      }
      const content = last?.content;
      const text =
        typeof content === "string"
          ? content
          : (content ?? [])
              .flatMap((block) => (block.type === "text" ? [block.text] : []))
              .join("");
      const first = text.split("\n")[0] ?? "";
      if (first.startsWith("bash "))
        return fauxAssistantMessage(
          [fauxToolCall("bash", { command: first.slice(5) })],
          { stopReason: "toolUse" },
        );
      if (first.startsWith("spawn "))
        return fauxAssistantMessage(
          [fauxToolCall("agent_spawn", JSON.parse(first.slice(6)))],
          { stopReason: "toolUse" },
        );
      return fauxAssistantMessage(`done: ${first}`);
    } finally {
      stats.active -= 1;
    }
  };
  faux.setResponses(Array.from({ length: 100 }, () => step));
  return { models, stats };
}

/** How often the requests switch from one agent to another. */
function switches(sessions: string[]): number {
  return sessions.filter(
    (each, index) => index > 0 && each !== sessions[index - 1],
  ).length;
}

test("the cap comes from piAgents.maxWorkingAgents", () => {
  expect(readWorkingLimit({})).toEqual({});
  expect(readWorkingLimit({ piAgents: { maxWorkingAgents: 2 } })).toEqual({
    limit: 2,
  });
  for (const value of [0, 1.5, "1"]) {
    const { limit, error } = readWorkingLimit({
      piAgents: { maxWorkingAgents: value },
    });
    expect(limit).toBeUndefined();
    expect(error).toContain("positive integer");
  }
});

describe("agents with a working cap", () => {
  let service: AgentService | undefined;

  afterEach(async () => {
    if (service) await closeService(service);
    service = undefined;
  });

  test("an agent keeps its slot across tool calls until its run ends", async () => {
    const { models, stats } = recording();
    service = await openService({ models, maxWorkingAgents: 1 });
    for (const name of ["a", "b", "c"])
      await service.spawnGraph({
        agents: [
          {
            job: "bash sleep 0.1",
            name,
            cwd: ".",
            model: MODEL,
          },
        ],
      });
    const current = service;
    await until(() => current.pendingDeliveries().length === 3, 10_000);
    expect(stats.sessions).toHaveLength(6);
    expect(new Set(stats.sessions).size).toBe(3);
    // Each agent's two requests follow each other.
    expect(switches(stats.sessions)).toBe(2);
    expect(stats.peak).toBe(1);
    expect(hostOf(current).extensions.working?.working).toBe(0);
  });

  test("an agent waiting for its agents lets them work", async () => {
    const { models, stats } = recording();
    service = await openService({ models, maxWorkingAgents: 1 });
    const helpers = [
      { name: "x", job: "map x" },
      { name: "y", job: "map y" },
      { name: "merge", job: "merge", after: ["x", "y"] },
    ];
    await service.spawnGraph({
      agents: [
        {
          name: "lead",
          job: `spawn ${JSON.stringify({ agents: helpers })}`,
          spawn: true,
          cwd: ".",
          model: MODEL,
        },
      ],
    });
    await service.wait(["lead"]);
    expect(service.get("lead")?.result?.text).toBe("merged");
    expect(stats.peak).toBe(1);
  });

  test("an agent stopped while it waits for a slot gives up its place", async () => {
    const { models, release } = createGatedFaux();
    service = await openService({ models, maxWorkingAgents: 1 });
    const current = service;
    const working = () => hostOf(current).extensions.working;
    for (const name of ["a", "b", "c"])
      await service.spawnGraph({
        agents: [
          {
            job: `hold ${name}`,
            name,
            cwd: ".",
            model: MODEL,
          },
        ],
      });
    await until(() => working()?.queued === 2);
    await service.stop("b");
    await until(() => working()?.queued === 1);
    release();
    const outcome = await service.wait(["a", "c"]);
    expect(outcome.graphs.map((each) => each.state)).toEqual(["idle", "idle"]);
  });
});
