---
title: Limit concurrent model requests of agents
type: feature
authors:
  - mavam
prs:
  - 75
created: 2026-10-09T07:29:06.603928Z
---

Cap how many model requests your agents send at once with `piAgents.maxConcurrentRequests` in `~/.pi/agent/settings.json` or your project's `.pi/settings.json`. This helps with model servers that handle one request at a time, such as local LLMs:

```json
{
  "piAgents": {
    "maxConcurrentRequests": 1
  }
}
```

Requests over the cap wait their turn in order instead of failing, and agents keep running tools in the meantime. Agents, graphs, and helpers all share the cap. Without the setting, requests aren't limited.
