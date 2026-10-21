---
title: Optional agent lifecycle hooks
type: feature
authors:
  - mavam
prs:
  - 110
created: 2026-10-20T16:11:06.82767Z
---

Co-loaded extensions can now capture persistent state when agents are created and customize their model requests through optional lifecycle hooks:

```ts
import type { AgentHooksDiscovery } from "pi-agents/hooks";

pi.events.on("pi-agents:hooks:discover", (value) => {
  const hooks = value as AgentHooksDiscovery | undefined;
  if (hooks?.protocol !== 1) return;
  hooks.register({
    namespace: "my-extension",
    onAgentCreate: () => ({ version: 1, enabled: true }),
    onAgentRequest: ({ state, model }, payload) => undefined,
  });
});
```

Each spawn captures one snapshot, which a graph's agents share. Each agent keeps it across follow-ups, compaction, and resumed sessions, and helpers inherit their creator's. A failing hook names its extension and error in the agent's error. Malformed or conflicting registrations are ignored with a notice, so a faulty extension never disables agents. Extensions without this integration and users without consumer extensions keep their existing behavior.
