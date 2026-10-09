---
title: Structured agent results for codemode scripts
type: feature
authors:
  - mavam
created: 2026-10-09T10:47:49.971508Z
---

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
