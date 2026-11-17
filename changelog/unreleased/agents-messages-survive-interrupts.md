---
title: Agents' messages survive interrupts
type: change
authors:
  - mavam
prs:
  - 124
created: 2026-11-17T05:36:29.79577Z
---

Interrupting an agent no longer drops the messages other agents queued for it. They stay queued and arrive with the agent's next input, since their senders can't take them back. Messages you and Pi queued are still dropped, as before, and stopping an agent still drops all of its queued messages.
