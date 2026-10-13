---
title: Cap working agents instead of model requests
type: breaking
authors:
  - mavam
created: 2026-10-13T19:24:47.059253Z
---

Cap how many agents work at once with `piAgents.maxWorkingAgents`, which replaces `piAgents.maxConcurrentRequests`. The old setting capped single model requests, so agents still took turns at the model between tool calls, and a local model server with one prompt cache reprocessed every agent's context at each switch. Now an agent keeps its slot from its first request until its work ends, and agents over the cap wait their turn:

```json
{
  "piAgents": {
    "maxWorkingAgents": 1
  }
}
```

An agent that waits for its helpers gives its slot to them meanwhile. pi-agents no longer reads `maxConcurrentRequests`; rename it in your settings.
