/**
 * A Pi process that dies while stopping an agent: it spawns a working agent
 * in the store at `argv[2]`, stops it, and exits at the first commit of the
 * stop that changes the agents' records, before the stop can finish.
 */

import {
  createGatedFaux,
  hostOf,
  jsonlStorage,
  MODEL,
  openService,
  until,
} from "./helpers.js";

const directory = process.argv[2] as string;
const service = await openService({
  storage: await jsonlStorage(directory),
  models: createGatedFaux().models,
});
await service.spawn({ name: "victim", job: "hold", cwd: ".", model: MODEL });
await until(() => service.get("victim")?.state === "working");
let stopping = false;
hostOf(service).harness.harness.subscribeCommits((publication) => {
  if (
    stopping &&
    publication.changes.some(
      (change) =>
        change.type === "document" && change.record.kind === "pi-agents.agents",
    )
  )
    process.exit(0);
});
stopping = true;
await service.stop("victim");
