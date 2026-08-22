---
title: Presentation problems no longer block workflow launches
type: change
authors:
  - mavam
created: 2026-08-22T05:58:48.081292Z
---

Invalid presentation settings no longer prevent a workflow from starting. An
invalid `display` path on `workflow_create` or the RPC `start` operation now
degrades to a warning, and the run starts with presentation falling back to
the complete result. Stray `params` on an inline flow are likewise ignored
with a warning instead of failing the request. RPC replies carry the new
optional `warnings` field.
