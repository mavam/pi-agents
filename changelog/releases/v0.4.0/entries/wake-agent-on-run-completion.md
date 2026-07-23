---
title: Wake the agent when a background run completes
type: bugfix
authors:
  - mavam
  - claude
prs:
  - 5
created: 2026-07-22T21:06:50Z
---

Workflow runs launched via the `workflow` tool now resume the outer agent
when they complete. Previously the completion notification was only rendered:
the tool told the model to end its turn, but the notification arrived without
triggering a new one, so the agent never continued its task with the result.

The final notification for tool-launched runs now triggers a new turn and
asks the agent to continue with the result. Runs started by slash commands or
event hooks keep the previous display-only behavior, so user-initiated runs
don't burn tokens on unsolicited commentary and hook-fired workflows can't
create feedback loops.
