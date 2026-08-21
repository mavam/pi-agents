---
title: First-class agent sessions and an interactive run panel
type: breaking
authors:
  - mavam
created: 2026-08-19T00:00:00.000000Z
---

Every delegated agent now has a persistent Pi session. You can attach to a
running agent for a live conversation or open a settled agent later with its
full history and tree navigation.

The run summary above the editor is now interactive. Press `←` from an empty
editor or `Ctrl+Q` to focus it, use `↑` and `↓` to select an agent, press
`Space` to collapse or expand a run, and press `Enter` to attach. The
`/workflows` browser offers the same attachment from a run's agent list;
press `o` there to post the agent's output to the parent conversation instead.

Attaching opens the agent transcript with a dedicated editor and hides the
parent workflow overview. Messages join the agent's existing session and wait
in a visible queue while its current tool-call batch runs. Press `Esc` to
interrupt the current turn, or press `←` from an empty editor to return to the
parent session. The pane uses a subtle themed badge and compact status icons
for queued, interrupted, deferred, submitted, and detached states.

An attached agent remains available even when it becomes idle. Result
submission and budget cancellation wait until you detach, so a timeout or
usage limit cannot end the conversation while you are inside the agent. After
you leave, the agent finishes its assignment and submits its workflow result.

This replaces the previous tailing and steering interfaces. The `t` tail key,
`s` steer key, `workflow_steer` tool, and steering RPC operation are removed;
attach to a running agent and type in its editor instead.

For extension consumers, the run-event protocol moves to version 4. The
`node_steered` event is removed, and the new `node_session` event reports the
persistent session file for a delegated agent.
