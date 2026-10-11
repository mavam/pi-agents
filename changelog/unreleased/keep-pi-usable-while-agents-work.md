---
title: Keep Pi usable while agents work
type: change
authors:
  - mavam
created: 2026-10-11T19:04:55.150684Z
---

Pi no longer blocks on agents by default. After starting agents, Pi tells you what it started and ends its turn or keeps working, and each result arrives on its own as a message, so you can keep talking to Pi while agents work. Pi waits with `agent_wait` only when a turn must combine results, for example in a codemode script, and a running wait now says that sending a message stops it.

Single-shot runs such as `pi --print` still wait for the results they need, since the run ends with Pi's answer.

Pi also treats a result as an agent's report rather than your request, acknowledges results briefly while other agents still work, never polls for results, and prefers a graph when you want several results together.
