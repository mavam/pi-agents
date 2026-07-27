---
title: Expanded workflow result delivery
type: change
authors:
  - mavam
  - codex
prs:
  - 21
created: 2026-07-27T16:15:23.461876Z
---

Workflow results now send up to 200,000 characters to the calling model, replacing the previous 600-character background and 16,000-character foreground limits. Step-to-step interpolation uses the same ceiling, and oversized results point to `/workflow <id> result` for complete retrieval. Completion cards retain a compact preview, while explicit run and per-agent result inspection returns the complete persisted value.
