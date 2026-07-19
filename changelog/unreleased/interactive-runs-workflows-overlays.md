---
title: Interactive /runs and /workflows overlays
type: feature
authors:
  - mavam
created: 2026-07-19T00:00:00.000000Z
---

`/runs` and `/workflows` now open a keyboard-navigable split-pane overlay in
the TUI: a table of one-line entries on top, the selected item's icon flow
tree below, refreshing live while runs execute. `↑`/`↓` (or `j`/`k`) move
the selection, `esc` closes, and single-letter actions operate on the
selected row — runs: `⏎` inspect, `c` cancel, `r` rerun; workflows: `⏎`
compose `/<name> ` in the editor, `r` run, `h` hide that workflow's runs
from the live summary widget, `n` create a new workflow or agent (you name
it, the model drafts the file). `/runs list` and `/workflows list` keep the
plain markdown output (always used in non-TUI modes), and `/runs widget`
toggles the live run summary above the composer.
