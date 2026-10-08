---
title: Finish graphs only after their agents' work is done
type: bugfix
authors:
  - mavam
created: 2026-10-08T19:04:09.304164Z
---

A graph now counts as working until all of its agents' work is done, including messages you sent to one of its agents while the graph ran. Before, such a graph could show as finished and report its result too early, and stopping it then had no effect. Now its result arrives once everything finished, and stopping it stops the remaining work.
