---
title: Interactive /runs and /workflows overlays
type: feature
authors:
  - mavam
created: 2026-07-19T00:00:00.000000Z
---

`/runs`, `/workflows`, and `/agents` now open a keyboard-navigable
split-pane overlay in the TUI: a table of one-line entries on top, the
selected item below — the flow tree with dataflow coloring (`{refs}` in
accent) plus full metadata: file, triggers, and params for workflows;
file, model, thinking, skills, and tools for agents — refreshing live
while runs execute. The overlay is pinned near the top of the screen and
the detail pane only ever grows, so the table never shifts while browsing.
`↑`/`↓` (or `j`/`k`) move the selection, `esc` closes, and single-letter
actions operate on the selected row — runs: `⏎` inspect with the full
result, `c` cancel, `r` rerun, `h` show/hide the run in the live summary
widget; workflows: `⏎` compose `/<name> ` in the editor, `r` run; agents:
`⏎` inspect.
`n` (workflows/agents) creates a new definition: you name it, the model
drafts the file. `list` keeps the plain markdown output (always used in
non-TUI modes), and `/runs widget` toggles the live run summary above the
composer.
