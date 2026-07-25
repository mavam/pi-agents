---
title: Elastic overlay height
type: bugfix
authors:
  - mavam
  - claude
prs:
  - 18
created: 2026-07-25T00:00:01Z
---

The interactive overlay now sizes itself to its content up to the full
terminal height. Previously a fixed 85% height cap sliced the rendered box
from the bottom on terminals taller than ~27 rows, silently eating the footer
and the tail of the detail pane. The cap is gone: the overlay budgets its own
height from the terminal, grows downward as the detail pane fills, and always
ends with the key-hint footer — long details are truncated explicitly with a
`… +N more lines` marker instead of being cut mid-box.
