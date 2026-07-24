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
explicitly opt-in, and it takes an affirmative request to run something —
"run the review workflow", "delegate this", "spawn agents for these", "do
these in parallel" — or a saved workflow you ask for by name or by the
situation its `trigger` declares. Merely saying *workflow* or *flow* is not a
request, and neither is asking about a saved workflow or editing one.

Everything else it does itself. The gate spells out the cases that used to
produce unwanted delegation — a large multi-step task, a long list of
independent items, a multi-file refactor, a review, an audit, a research
question, or anything the model privately judged parallelizable — and states
that none of them is a trigger. When a workflow really is the better tool but
you did not ask for one, you get the work plus a one-line mention that a
workflow could take it, instead of a background run.

The tool also only ever starts runs, so it is no longer reached for on an
existing one: a live agent is corrected with `steer`, and a run is inspected
or stopped with `/run`.

The `<workflows>` catalog in the system prompt carries the same framing: it is
a reference, not an invitation, so a saved workflow merely existing for a task
is never by itself a reason to run one.
