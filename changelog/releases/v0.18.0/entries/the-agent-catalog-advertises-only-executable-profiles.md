---
title: The agent catalog advertises only executable profiles
type: change
authors:
  - mavam
created: 2026-08-22T05:58:59.138075Z
---

The advertised agent catalog now uses the runtime invocation resolver to
check profiles. Profiles with unavailable skills or models, forbidden tools,
or another runtime resolution problem are listed separately with the same
reason that launch preflight would report. This remains a best-effort check;
resources can change after prompt rendering.
