---
title: Pi starts without waiting for agents
type: change
authors:
  - mavam
prs:
  - 129
created: 2026-11-20T17:00:38.142018Z
---

Resuming a session with agents in Pi's terminal no longer holds Pi's start while the agents open, which could take up to ten seconds when an MCP server connected slowly. The agents open in the background and show in the panel once they did. Print, JSON, and RPC modes still wait for them, so a run sees what its agents deliver.
