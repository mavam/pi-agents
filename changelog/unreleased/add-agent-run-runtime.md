---
title: Add agent workflow runtime
type: feature
authors:
  - mavam
  - codex
created: 2026-03-15T00:00:00Z
---

You can now orchestrate multiple agents with the new `workflow` tool. Define a
flow spec as a JSON tree of nodes, and the runtime executes them for you—
running each agent as an isolated subprocess.

Five node kinds are available:

- **`spawn`**: run a single agent and return its output as text or parsed JSON.
- **`sequence`**: run steps one after another, threading results forward.
- **`fork`**: run named branches concurrently, with an optional concurrency cap.
- **`join`**: wait for a fork's branches to finish, combining results via a
  `collect` or `agent` reducer. Supports `all`, `any`, and `quorum` modes.
- **`loop`**: repeat a body node up to `maxIterations` times, with an optional
  `continueWhen` predicate that checks a field in the body's JSON output.

Budgets let you cap nesting depth, child count, parallelism, and loop
iterations across the entire workflow.

For example, a review loop that alternates between a reviewer and an engineer
until the reviewer signals `done` (or three iterations pass):

```json
{
  "label": "review loop",
  "flow": {
    "kind": "loop",
    "id": "review-loop",
    "maxIterations": 3,
    "continueWhen": {
      "kind": "result_field",
      "path": "done",
      "equals": false
    },
    "body": {
      "kind": "sequence",
      "steps": [
        {
          "kind": "spawn",
          "id": "review",
          "agent": "reviewer",
          "task": "Review the current patch. Return JSON with done, findings, and summary.",
          "output": "json"
        },
        {
          "kind": "spawn",
          "id": "implement",
          "agent": "engineer",
          "task": "Implement the latest review findings."
        }
      ]
    }
  },
  "budgets": { "maxIterations": 3, "maxParallelism": 2 }
}
```

Every workflow execution is persisted as a flow in your session. Use `/flows`
to browse past flows and `/flow <id>` to inspect one in detail. Flows survive
session reloads.
