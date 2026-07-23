---
title: Live workflow agent steering
type: feature
authors:
  - mavam
  - codex
prs:
  - 10
created: 2026-07-23T12:37:58.07859Z
---

Running workflow agents can now receive course corrections without being
stopped or restarted. In `/runs`, drill into a run's agents and press `s` on a
live node to compose a message. Models can use the separate `steer` tool, and
other extensions can use the typed client:

```ts
await agents.steer({
  runId,
  instance: "$.branches.reviewer",
  message: "Prioritize the retry failure.",
});
```

The instance may be omitted when exactly one agent in the run is steerable.
Accepted messages appear in the node's persisted history with user, tool, or
RPC attribution. Messages are limited to 2,000 characters and are delivered
after the current assistant turn finishes its tool calls.
