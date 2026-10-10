---
title: Keep tool results true after the call
type: change
authors:
  - mavam
prs:
  - 85
created: 2026-10-10T19:54:44.918633Z
---

Tool results now show only what stays true after the call returns. They no longer carry timers, what a working agent was doing, or a `result queued` note that went stale in the transcript. A wait that gives up marks the agents and graphs it stopped waiting for with `⊠` and ends with why, such as `Timed out` or `Stopped waiting for your message`. A graph call shows the agents it started below its arguments, and the outcome replaces them once it waited. Results look the same while a call runs, after it finished, and when you resume the session, also for sessions from earlier versions.
