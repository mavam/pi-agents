---
title: Taller, scrollable panel detail pane
type: change
authors:
  - mavam
---

The `/workflows` and `/agents` panel now budgets up to 80% of the terminal
height instead of 60%, and detail longer than that budget scrolls instead of
being clipped to a `… +N more lines` marker.

`⇧↑`/`⇧↓` (or `ctrl+y`/`ctrl+e`) scroll the detail pane by a line,
`⇧PgUp`/`⇧PgDn` (or `ctrl+u`/`ctrl+d`) by a pane, and `⇧Home`/`⇧End` jump to
either end. Plain arrows and `j`/`k` still move the table selection, so the
single-letter actions keep their meaning. The footer advertises `⇧↑↓ scroll`
only while something is hidden, every row keeps its own scroll offset, and a
live agent tail stays pinned to the newest line until you scroll up — scrolling
back to the bottom re-arms following.
