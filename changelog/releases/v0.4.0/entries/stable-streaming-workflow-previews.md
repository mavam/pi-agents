---
title: Stable streaming workflow previews
type: bugfix
authors:
  - mavam
  - codex
prs:
  - 7
created: 2026-07-23T10:58:47.838361Z
---

Inline `workflow` tool calls no longer flicker between their structured flow
tree and a raw JSON blob while arguments stream in. The preview now retains
the newest valid tree through temporarily incomplete fields and branches, while
completed invalid calls still show the raw diagnostic preview.
