---
title: The agent catalog advertises only executable profiles
type: change
authors:
  - mavam
created: 2026-08-22T05:58:59.138075Z
---

The advertised agent catalog now checks executability: profiles whose skills
or model cannot resolve in the current scope are listed separately with a
reason instead of being selectable. This is best-effort staleness reduction;
runtime resolution errors remain authoritative.
