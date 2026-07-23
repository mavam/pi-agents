---
title: Reliable delegated agent completion
type: bugfix
authors:
  - mavam
  - codex
prs:
  - 9
created: 2026-07-23T12:56:21.210556Z
---

Delegated agents now wait until Pi has fully settled before returning their
final response. Automatic retries, context compaction, queued continuations,
and nested headless workflows can finish instead of being cut off after the
first completed turn. Cancellation and shutdown also stop child processes
within a bounded time.

Delegation now uses Pi's current RPC protocol. Update Pi before using this
version:

```sh
pi update pi
```
