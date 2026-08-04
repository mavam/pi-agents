---
title: Width-aware run summary keeps the glyph strip visible
type: change
authors:
  - mavam
  - claude
created: 2026-08-04T05:34:21Z
---

The live run summary above the composer now adapts to the terminal width
instead of truncating blindly on the right. Long workflow labels used to push
the glyph strip — the most important liveness signal — off screen on narrow
terminals.

The line now budgets its parts so the strip always survives. When space runs
short, the least useful pieces give way first: the run id drops as soon as
the full label no longer fits (it remains available in `/workflows`), then
the token count, then the elapsed time. The label itself shrinks with an
ellipsis toward an eight-column floor, and the output excerpt tail absorbs
any final truncation as before.

```
❖ 100% · review-and-fix-the-parser · w1a2b3c4 · 1m32s · 4.5k · ◆◆⑂   (wide)
❖ 100% · review-and-fix-t… · 1m32s · 4.5k · ◆◆⑂                      (80 cols)
❖ 100% · review-a… · ◆◆⑂                                             (minimal)
```
