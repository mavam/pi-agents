---
title: Terminal delegated workflow agents
type: breaking
authors:
  - mavam
  - codex
prs:
  - 43
created: 2026-08-04T16:19:41.504995Z
---

Delegated agents now act as terminal workflow leaves. Pi-agents keeps its
workflow tools, catalogs, commands, hooks, RPC endpoint, run manager, and UI in
the originating process, which prevents a delegated assignment from
recursively triggering another workflow. Static saved-workflow composition is
unchanged because the parent interpreter expands and executes those nodes.

Agent and reducer tool lists can no longer include `workflow` or `steer`.
Workflows that relied on an agent starting another workflow must express that
composition in the parent flow with workflow, parallel, map, loop, or while
nodes.
