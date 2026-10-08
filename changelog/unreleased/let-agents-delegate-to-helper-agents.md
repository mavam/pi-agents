---
title: Let agents delegate to helper agents
type: feature
authors:
  - mavam
created: 2026-10-08T19:37:49.549342Z
---

Agents can now delegate: an agent you let delegate splits its own task while it works. It starts helper agents, waits for them, and continues with their results, for example one helper per file it finds and a helper that merges their reviews. Ask Pi for an agent that may delegate, or set `delegate: true` in a profile.

Helpers form a graph like the ones Pi starts, with the same edges. Their results go to the agent that started them, and only that agent's answer reaches Pi. The panel draws helpers below their agent, which shows their progress, such as `delegating · mapper.helpers 2/4`. Helpers run on their agent's model and get only its tools, can't delegate themselves, and stop when you press Esc on their agent or stop a graph it belongs to. Agents survive restarts in the middle of delegating without starting their helpers twice.
