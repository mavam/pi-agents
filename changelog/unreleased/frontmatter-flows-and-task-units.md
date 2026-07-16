---
title: Frontmatter flows and reusable task units
type: feature
authors:
  - mavam
created: 2026-07-17T00:00:00.000000Z
---

Workflow files no longer carry YAML twice: the flow expression moves into the
frontmatter under a `flow:` key and the markdown body becomes pure
documentation (the fenced-block form is gone). Single-unit workflows can skip
the graph entirely with the flat form — `agent:` plus optional `task:`,
`model:`, `thinking:` — which normalizes to a bare agent leaf while keeping
full workflow powers (params, slash command, hooks, cross-workflow
references). Agents themselves become reusable task units: agent files may
define a default `task:` so flow nodes can reference them by name alone, and
agent nodes accept `model:`/`thinking:` overrides with the precedence flow
node → agent file → active session. Preflight verifies that every taskless
node references an agent with a default task before anything spawns.
