/**
 * A Pi process that crashes while an agent works: it spawns an agent in the
 * store at `argv[2]` and exits without closing the store once the agent's
 * model request is in flight and stored as such.
 */

import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { jsonlStorage, MODEL, openService, until } from "./helpers.js";

const directory = process.argv[2] as string;
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
let requested = false;
faux.setResponses([
  () => {
    requested = true;
    return new Promise(() => {});
  },
]);
const service = await openService({
  storage: await jsonlStorage(directory),
  models,
});
await service.spawnGraph({
  agents: [{ name: "victim", job: "hold", cwd: ".", model: MODEL }],
});
await until(() => requested);
// Progress such as the request's attempt is stored within a second.
await new Promise((resolve) => setTimeout(resolve, 1_500));
process.exit(0);
