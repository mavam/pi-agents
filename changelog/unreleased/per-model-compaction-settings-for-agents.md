---
title: Per-model compaction settings for agents
type: feature
authors:
  - mavam
prs:
  - 108
created: 2026-10-19T07:19:42.044722Z
---

Agents now compact with Pi's per-model token settings in `compaction.modelOverrides`: an agent on a listed model uses that entry's `reserveTokens` and `keepRecentTokens`, so agents on small- and large-window models each compact at the right size. Before, agents used only the general compaction settings.
