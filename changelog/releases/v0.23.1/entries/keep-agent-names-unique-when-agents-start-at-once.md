---
title: Keep agent names unique when agents start at once
type: bugfix
authors:
  - mavam
created: 2026-10-08T19:04:08.291556Z
---

Agents and graphs started at the same time no longer end up with the same name. Before, two agents started at once with the same name both succeeded, which made the name ambiguous. Now the second one fails with an error that the name is taken, and generated names stay distinct.
