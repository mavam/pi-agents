---
title: Review hardening and correctness fixes
type: bugfix
authors:
  - mavam
created: 2026-07-16T00:00:00.000000Z
---

Run events now persist to a sidecar file (`<session>.pi-agents.jsonl`)
instead of being appended into the session file, which could fork pi's
session tree on reload. Project-local hook workflows require a one-time
interactive confirmation before auto-running, hooks never install in
delegated child processes, and `session_start` hooks see their own trigger.
Preflight resolves agents with each node's effective cwd/scope; agents
without frontmatter inherit the active session's model and thinking; an
explicit `tools: []` now means no tools (`--no-tools`) instead of all tools;
`maxParallelism` is enforced globally across nested pools and effective
budget limits propagate to children via `PI_AGENTS_BUDGETS`; budget values
are validated as positive integers; and full run results are retrievable
with `/run <id> result` while model-facing tool output is bounded.
