---
title: Run values persist uncropped
type: change
authors:
  - mavam
  - claude
prs:
  - 6
created: 2026-07-23T10:24:31Z
---

Node and run values used to be truncated to 16k characters when written
to the sidecar, so large agent outputs were silently cropped after a pi
restart. Since the final message is the sole artifact of an agent's
work, the sidecar now persists values in full — `/run <id> result` and
the per-agent views return the complete output in any later session.
The 16k bound still applies where it belongs: to the value embedded in
the `workflow` tool result, protecting the calling model's context.
