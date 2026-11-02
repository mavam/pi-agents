---
title: Turn limits for agent profiles
type: feature
authors:
  - mavam
created: 2026-10-31T08:11:53.900025Z
---

Profiles can now limit how many tool rounds one run of an agent takes:

```md
---
name: scout
description: Maps a codebase quickly
maxTurns: 20
---
```

The round that reaches the limit still runs its tools, then the agent fails with `reached its turn limit`. Press `r` in `/agents` to continue it for another run.

Only profiles set the limit; `agent_spawn` has no argument for it. A turn limit is your budget for an agent, so the model that spawns agents can't loosen or skip it. It can pick a profile that has one, and it sees when an agent reached its limit, but only you can continue that agent.
