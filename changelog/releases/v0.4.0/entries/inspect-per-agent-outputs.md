---
title: Inspect each agent's output within a run
type: feature
authors:
  - mavam
  - claude
prs:
  - 6
created: 2026-07-23T10:24:31Z
---

A run's per-agent outputs are now inspectable, not just the run-level
result. In the `/runs` overlay, press `a` on a run to drill into its
agents: one row per agent (and reducer) with status and usage, the
selected agent's output preview in the detail pane — or a live progress
tail while it is still running — `⏎` to post the full output to the
chat, and `esc` to step back to the run list.

The command surface gained matching verbs: `/run <id> agents` lists a
run's agents with collapsed previews, and `/run <id> result <node>`
prints one agent's complete output. Nodes are addressable by display
name (`bugs`, `@2`), agent name, or instance path, with tab completion
walking id → verb → node name. The run tree now keeps each node's kind
glyph and encodes the outcome in its color — green completed, red
failed — matching the run rows and the live widget, so both progress
and fork/join structure read at a glance; colorless contexts (markdown
fences) pair the glyph with a status icon instead.
