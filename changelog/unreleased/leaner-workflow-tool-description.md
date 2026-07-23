---
title: Leaner workflow tool description
type: change
authors:
  - mavam
  - claude
prs:
  - 11
created: 2026-07-23T17:36:19.598274Z
---

The `workflow` tool now sends its node grammar to the model once per request
instead of twice: the `flow` parameter defers to the tool description rather
than repeating the full grammar, and the description itself is tighter. This
cuts the tool's fixed per-request token footprint by more than half while
keeping every node kind, predicate, and binding rule.
