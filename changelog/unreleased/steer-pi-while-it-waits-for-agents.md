---
title: Steer Pi while it waits for agents
type: bugfix
authors:
  - mavam
prs:
  - 71
created: 2026-10-08T18:03:32.504642Z
---

Steering Pi while it waits for agents now works. Before, a message you sent while Pi waited for an agent's result stayed queued until the agent answered. Now your message ends the wait right away and Pi responds to it. The agents keep working, and their results arrive as messages. Follow-up messages still wait until Pi is done.
