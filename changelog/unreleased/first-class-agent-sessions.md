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
`⏎` on an agent to attach. Attaching to a running agent turns the panel into
that agent's live transcript, rendered with pi's own message components —
identical to the main conversation — while the editor stays in place as the
agent's composer: everything you submit goes to the agent, `esc` interrupts
its current turn like in a normal pi session (the agent stays attached and
promptable), `←` goes back to the parent, and an inverted badge above the
editor names the agent you are talking to. A settled agent opens as its own
pi session — also reachable any time via the new `/agent-session` command —
with full history and tree navigation. The `/workflows` overlay's agent tier
gained the same `⏎` attach action (`o` posts the full output).

Interactive attach replaces the previous tailing and steering features
entirely: the `t` tail and `s` steer keys, the `workflow_steer` tool, and the
RPC `steer` operation are gone. The run-event schema moved to v4, dropping
`node_steered` and adding `node_session` (the agent's session file, persisted
so finished agents stay attachable across restarts).
