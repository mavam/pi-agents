---
title: Bounded review-and-fix cycles
type: feature
authors:
  - mavam
  - claude
  - codex
prs:
  - 25
created: 2026-08-01T08:48:03.588482Z
---

Workflows can now use bounded, pre-checked `while` nodes to carry JSON state through zero or more iterations with explicit `current` and `iteration` values. The new `/review-fix` workflow reviews the checkout first, performs and verifies up to three repair rounds only when actionable findings remain, and returns a flat structured result with the final report, findings, implementation summary, and round index. `/review` remains the read-only option; `/review-fix` explicitly mutates the working tree.
