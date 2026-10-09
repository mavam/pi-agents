---
title: Show results that wait for Pi
type: change
authors:
  - mavam
created: 2026-10-09T10:11:59.509361Z
---

When an agent answers while Pi is still busy, its answer waits until Pi's turn ends. The panel, the attach view, and `/agents` now show such an agent with `●` in the accent color and `result queued`, rather than the green dot that suggests Pi already has the answer. Finished graphs whose result waits show the same.
