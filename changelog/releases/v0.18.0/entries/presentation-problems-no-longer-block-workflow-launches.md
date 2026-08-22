---
title: Presentation problems no longer block workflow launches
type: change
authors:
  - mavam
created: 2026-08-22T05:58:48.081292Z
---

Invalid request-time `display` and `label` values no longer prevent a workflow
from starting. The run falls back to its default presentation, and stray
`params` on an inline flow are likewise ignored instead of failing the
request. Warnings are stored with the run for later inspection, and RPC start
replies include them in the optional `warnings` field.
