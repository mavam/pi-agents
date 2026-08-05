---
title: Explicit delegated agent results
type: change
authors:
  - mavam
  - codex
prs:
  - 46
created: 2026-08-04T21:27:07.565824Z
---

Each delegated agent now returns its node value through a dedicated **Submit Agent Result** tool that pi-agents injects into the agent run. Previously, pi-agents treated the last assistant message as opaque output and parsed JSON only after the run ended.

The injected tool adapts to the flow node's `output` contract: `output: text` accepts a string, while `output: json` accepts any JSON value. Pi validates the submission before accepting it, so the agent can correct an invalid call. An accepted submission terminates the agent and becomes the node value.

Assistant messages remain visible as live progress but never become results. The submission tool also remains available when `tools: []` disables every working tool. An agent that settles without an accepted submission fails instead of falling back to assistant prose.

Custom spawn engines now receive the required result mode and return the accepted `value` rather than assistant `text`.
