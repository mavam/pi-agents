---
title: Fence run result previews
type: bugfix
authors:
  - mavam
created: 2026-07-19T00:00:00.000000Z
---

Run-completed notifications spliced the raw result preview into their
markdown, so JSON values were reflowed into a mangled blob by the renderer.
Previews are now wrapped in a code fence that grows past any backtick runs
embedded in the value; `/run <id>` details and `/run <id> result` use the
same fencing, fixing results that contain triple backticks themselves.
