---
title: Workflow and agent browsers at the composer
type: change
authors:
  - mavam
  - claude
prs:
  - 23
created: 2026-07-28T11:37:11.413947Z
---

The `/workflows` and `/agents` browsers now open in place of the composer instead of floating near the top of the terminal, matching where pi shows `/settings` and `/model`.

On tall or vertical terminals the split pane previously appeared a screenful away from where you were typing, so it was easy to miss entirely. It now opens directly above the input you just typed into. The panel caps itself at roughly 60% of the terminal height to keep the conversation visible above it, and `esc` closes it and restores the composer as before.

The live run summary now also hides itself while a browser panel is open, since the panel sits directly below it and already reports the same run state. It comes back when you close the panel, and both `/workflows widget` and per-run `h` choices are preserved.

Pressing `r` on a workflow row keeps the panel open too, so you can watch the run you just started instead of being dropped back at the composer. This matches `r` on a run row, which already stayed open when rerunning.
