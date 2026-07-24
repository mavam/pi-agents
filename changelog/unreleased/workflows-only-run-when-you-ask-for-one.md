---
title: Workflows only run when you ask for one
type: change
authors:
  - mavam
  - claude
prs:
  - 16
created: 2026-07-24T20:33:58.806143Z
---

The `workflow` tool no longer starts runs you did not ask for. It is now
explicitly opt-in: the model may reach for it when you say *workflow* or
*flow*, ask it to delegate or to use parallel, background, or sub agents, name
a saved workflow (or describe the situation its `trigger` declares), or refer
to an existing run.

Everything else it does itself. The gate spells out the cases that used to
produce unwanted delegation — a large multi-step task, a long list of
independent items, a multi-file refactor, a review, an audit, a research
question, or anything the model privately judged parallelizable — and states
that none of them is a trigger. When a workflow really is the better tool but
you did not ask for one, you get the work plus a one-line mention that a
workflow could take it, instead of a background run.

The `<workflows>` catalog in the system prompt carries the same framing: it is
a reference, not an invitation, so a saved workflow merely existing for a task
is never by itself a reason to run one.
