---
title: Hold agents' model calls from extensions
type: feature
authors:
  - mavam
prs:
  - 112
created: 2026-10-21T07:57:47.117413Z
---

Co-loaded extensions can now hold agents' model calls, for example during peak pricing, with an optional `beforeAgentRequest` hook:

```ts
discovery.register({
  namespace: "peak-pricing",
  beforeAgentRequest: async ({ model, signal }) => {
    while (isPeak(model.provider, Date.now())) await sleep(60_000, signal);
  },
});
```

Each generation request and compaction summary waits until the callback returns. Held agents keep working: they receive messages, and tools they already called finish. Stopping, interrupting, and shutting down end a hold. The extension owns its policy, including manual holds and status; pi-agents only waits.
