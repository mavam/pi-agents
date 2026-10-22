/**
 * A Pi process that crashes while an agent works: it spawns a working agent
 * in the store at `argv[2]` and exits without closing the store.
 */

import {
  createGatedFaux,
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
await service.spawnGraph({
  agents: [{ name: "victim", job: "hold", cwd: ".", model: MODEL }],
});
await until(() => service.get("victim")?.state === "working");
process.exit(0);
