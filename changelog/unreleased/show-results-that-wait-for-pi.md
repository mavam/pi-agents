---
title: Show results that wait for Pi
type: change
authors:
  - mavam
created: 2026-10-09T10:11:59.509361Z
---

When an agent answers while Pi is still busy or while you are attached, its answer waits until Pi can take it. The panel, the attach view, and `/agents` now show such an agent with `●` in the accent color and `result queued`, rather than the green dot that suggests Pi already has the answer. Finished graphs whose result waits say `result queued` too; a failed one keeps its red glyph.
