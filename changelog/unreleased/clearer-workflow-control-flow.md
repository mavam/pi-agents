---
title: Clearer workflow control flow
type: bugfix
authors:
  - mavam
  - codex
prs:
  - 38
created: 2026-08-04T09:27:31Z
---

Exact-reference parameters now preserve their JSON type when passed into a
saved workflow, enabling value-only sub-workflows to carry objects and arrays
without stringifying them.

Run trees also distinguish unchosen switch arms from pending work and show loop
and while rounds against their effective cap. A while loop whose initial
condition is false appears as `[#0/max]`.
