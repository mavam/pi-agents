---
title: Agent tools return data to codemode scripts
type: feature
authors:
  - mavam
prs:
  - 108
created: 2026-10-19T07:15:04.514368Z
---

Codemode scripts of agents now get structured results from `agent_status`, `agent_send`, and `agent_spawn` instead of their text. `agent_status` returns the agents a script can message with their state, model, and job; `agent_send` the recipient, the mode, whether it interrupted the recipient, and how many queued messages it dropped; and `agent_spawn` the group and its agents with their IDs and full names:

```js
const { group, agents } = await tools.agent_spawn({ agents: [{ name: "scout", job: "Map src/" }] });
```

A refused call rejects in the script with its reason. The model still reads the same text as before.
