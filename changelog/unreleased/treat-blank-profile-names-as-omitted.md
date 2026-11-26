---
title: Treat blank profile names as omitted
type: bugfix
authors:
  - sunnysab
prs:
  - 137
created: 2026-11-26T08:15:56Z
---

Agent creation now treats an empty or whitespace-only profile name the same as an omitted profile. Unknown non-blank names still produce an error.
