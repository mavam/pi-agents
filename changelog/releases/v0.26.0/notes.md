Codemode scripts now receive agent results as structured data, so they can filter and return only what matters. Pi also marks agents whose answers wait for it as queued, and waits no longer report stale answers.

## 🚀 Features

### Structured agent results for codemode scripts

Codemode scripts now get the results of the agent tools as data instead of text. `agent_spawn` and `agent_send` resolve to the agent with its `name`, `state`, and `result` or `error`. `agent_spawn_graph` resolves to the graph with how each of its agents ended its task. `agent_wait` and `agent_status` resolve to lists of agents and graphs, and a wait names the agents and graphs still `pending` when it ended.

A script can start several agents, wait for them, and return only what matters:

```js
const names = ["api", "tests", "docs"];
await Promise.all(
  names.map((name) => tools.agent_spawn({ name, task: `Review the ${name}.` })),
);
const { agents, pending } = await tools.agent_wait({ names, timeout: 600 });
return { failed: agents.filter((a) => a.state === "failed"), pending };
```

Pi still reads the same text when it calls the tools directly.

*By @mavam.*

## 🔧 Changes

### Show results that wait for Pi

When an agent answers while Pi is still busy or while you are attached, its answer waits until Pi can take it. The panel, the attach view, and `/agents` now show such an agent with `●` in the accent color and `result queued`, rather than the green dot that suggests Pi already has the answer. Finished graphs whose result waits say `result queued` too; a failed one keeps its red glyph.

*By @mavam.*

## 🐞 Bug fixes

### Stale answers after interrupted or failed follow-ups

Waiting for an agent no longer reports its previous answer when its latest turn produced none. If you stopped an agent's follow-up before it wrote anything, Pi used to get the earlier answer as the result. A follow-up that failed without an error message used to report the earlier answer as the error. Waits now report only what the latest turn produced, and a failed turn says why it failed, such as `no_model`.

*By @mavam in #77.*
