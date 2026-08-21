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
`←` from an empty editor or `ctrl+q` to focus it. Runs start expanded into
their color-coded agent lists. Use `↑` and `↓` to navigate, `space` to
collapse or re-expand a run, and `⏎` to attach to an agent.

Attaching to a running agent hides the run panel and opens an agent pane in
the editor slot. The pane renders the live transcript with pi's message
components and includes an embedded editor for talking to the agent. Press
`esc` to interrupt the current turn and keep the agent attached, or press `←`
from an empty editor to return to the parent session. A subtle, neutral badge
names the attached agent using the theme's muted message colors. A settled agent
opens as its own pi session with full history and tree navigation. You can also
open it with `/agent-session`. The `/workflows` overlay uses the same `⏎`
attach action, while `o` posts the full output. The parent workflow overview
stays hidden while you are inside an agent, so its transcript ends cleanly at
the editor border. Dim lifecycle notices now align at the left edge and use
consistent sentence case, punctuation, separators, and distinct semantic
icons. Pressing `esc`
immediately switches the active tool to its failure background while
cancellation completes. Every attached message asks for a visible assistant
reply before the agent uses tools or resumes its assignment. A deferred result
submission also tells the agent to emit the reply instead of ending with an
invisible tool call. Per-agent and run-level budget cancellation waits until
you detach, so a configured timeout or usage limit cannot end the agent while
you are inside its pane.

Interactive attach replaces the previous tailing and steering features
entirely: the `t` tail and `s` steer keys, the `workflow_steer` tool, and the
RPC `steer` operation are gone. The run-event schema moved to v4, dropping
`node_steered` and adding `node_session` (the agent's session file, persisted
so finished agents stay attachable across restarts).
