---
title: Optional agent lifecycle hooks
type: feature
authors:
  - mavam
created: 2026-10-20T16:08:44.431683Z
---

Co-loaded extensions can now capture persistent state when agents are created and customize their model requests through optional lifecycle hooks:

```ts
pi.events.on("pi-agents:hooks:discover", (hooks) => {
  if (hooks.protocol !== 1) return;
  hooks.register({
    namespace: "my-extension",
    onAgentCreate: () => ({ version: 1, enabled: true }),
    onAgentRequest: ({ state, model }, payload) => undefined,
  });
});
```

Each agent keeps its captured state across follow-ups, compaction, and resumed sessions. Helpers inherit their creator's state. Extensions without this integration and users without consumer extensions keep their existing behavior.
