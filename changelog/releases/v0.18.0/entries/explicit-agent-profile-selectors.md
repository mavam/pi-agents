---
title: Explicit agent profile selectors
type: breaking
authors:
  - mavam
created: 2026-08-22T07:58:41.044415Z
---

Agent nodes and reducers now select reusable agent profiles with `profile`. The
old agent-node `name`, reducer `agent`, and flat-workflow `agent` fields are no
longer accepted.

Before:

```yaml
kind: agent
name: reviewer
task: Review the change
```

After:

```yaml
kind: agent
profile: reviewer
task: Review the change
```

Reducers and flat single-agent workflows use the same `profile` field. Omit it
for an anonymous ad-hoc agent. Parallel branch keys such as `alpha` identify
branches and no longer resemble profile selectors. The event and RPC protocol
is now version 2, and persisted run records use that same versioned envelope.
Records from other protocol versions are ignored.
