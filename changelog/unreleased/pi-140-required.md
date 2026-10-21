---
title: Pi 1.4.0 required
type: breaking
authors:
  - mavam
prs:
  - 108
created: 2026-10-22T05:23:26.064383Z
---

pi-agents now requires Pi 1.4.0 or later, so update Pi before updating pi-agents. Sessions keep their agents across the update. Going back to an earlier pi-agents version afterwards isn't supported: it may never resume an agent that was waiting to retry a failed request.
