---
title: First-class agent sessions and an interactive run panel
type: feature
authors:
  - mavam
  - claude
created: 2026-08-19T00:00:00.000000Z
---

Delegated agents are now first-class: every agent writes a real pi session
into a pi-agents-owned directory, and you can attach to any of them.

The passive run summary above the editor became an interactive panel. Press
`←` from an empty editor (or `ctrl+q`) to focus it, navigate runs with
`↑`/`↓`, expand a run into its color-coded agent list with `space`, and hit
`⏎` on an agent to attach. A running agent opens the new agent console — its
live transcript with an input line, so you can talk to the agent directly and
watch it respond; `esc` detaches while it keeps working. A settled agent opens
its own pi session as the active session, with full history and tree
navigation. While a console is attached, the panel collapses to a one-line
status for that agent. The `/workflows` overlay's agent tier gained the same
`⏎` attach action (`o` posts the full output).

Interactive attach replaces the previous tailing and steering features
entirely: the `t` tail and `s` steer keys, the `workflow_steer` tool, and the
RPC `steer` operation are gone. The run-event schema moved to v4, dropping
`node_steered` and adding `node_session` (the agent's session file, persisted
so finished agents stay attachable across restarts).
