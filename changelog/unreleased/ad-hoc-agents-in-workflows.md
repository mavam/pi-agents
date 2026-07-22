---
title: Ad-hoc agents in workflows
type: feature
authors:
  - mavam
  - claude
prs:
  - 4
created: 2026-07-22T20:51:20.051278Z
---

Inline and saved workflows now run without configuring agent profiles. Omit
the agent `name` on a leaf (or `agent` on a reducer) to launch a generic
delegated pi process that uses the active session's model and thinking level,
the given task, and the normal tool environment:

```json
{
  "flow": {
    "kind": "parallel",
    "branches": {
      "bugs":    { "kind": "agent", "task": "Review src/run for bugs" },
      "clarity": { "kind": "agent", "task": "Review src/run for clarity" }
    },
    "reduce": { "task": "Merge and prioritize:\n{branches}" }
  }
}
```

Saved workflows gain the same power: the flat form now needs only `task:`,
and explicit `flow:` trees may use anonymous leaves anywhere. Anonymous
agents render as `ad-hoc` in trees, widgets, and Mermaid diagrams. Named
agent profiles keep their exact semantics and remain the way to attach a
reusable persona, tool allowlist, or skills.
