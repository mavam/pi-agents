---
title: Schema-driven delegated agent results
type: change
authors:
  - mavam
  - codex
prs:
  - 46
created: 2026-08-04T21:27:07.565824Z
---

Each delegated agent now completes through a dedicated **Submit Agent Result** tool that pi-agents injects with the result contract declared by its flow node. Previously, pi-agents treated the last assistant message as opaque output and parsed JSON only after the run ended.

Omit `json` for a string or Markdown result. For a machine-readable result, provide a concrete JSON Schema Draft 7 object:

```yaml
kind: agent
task: Review the change.
json:
  type: object
  required: [outcome, report]
  properties:
    outcome: { enum: [approved, changes_required] }
    report: { type: string }
  additionalProperties: false
```

The tool accepts either `{result: payload}` or `{error: {reason: "..."}}`. Pi validates the envelope and payload before accepting them, so the agent can correct an invalid submission. A result terminates the agent and becomes the node value; an error terminates the agent and fails the node with its reason.

Assistant messages remain visible as live progress but never become results. The submission tool also remains available when `tools: []` disables every working tool. An agent that settles without an accepted submission fails instead of falling back to assistant prose.

This is a breaking flow and engine API change. Remove `output: text`; replace each `output: json` with its concrete `json` schema. Custom spawn engines now receive `resultSchema`, return the accepted unwrapped `value`, and use `AgentErrorResult` for an agent-submitted error.
