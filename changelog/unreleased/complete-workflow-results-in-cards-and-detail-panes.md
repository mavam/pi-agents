---
title: Complete workflow results in cards and detail panes
type: bugfix
authors:
  - mavam
  - codex
prs:
  - 36
created: 2026-08-04T07:49:26.882843Z
---

Completion cards and run and agent detail panes now present complete workflow results instead of ending at fixed character limits. Terminal-sized detail panes still constrain how many rows are visible at once, and `/workflow <id> result` remains available for the complete raw value.
