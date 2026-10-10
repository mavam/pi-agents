---
title: Stop the clock for finished agents
type: bugfix
authors:
  - mavam
created: 2026-10-10T12:03:58.388647Z
---

The `/agents` overlay no longer keeps counting time for agents and graphs that finished. Each row shows how long it ran, from its start until it finished, and that time stays the same afterwards. If you resume an agent, its time picks up again and includes the pause.
