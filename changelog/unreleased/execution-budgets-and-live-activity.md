---
title: Execution budgets and live activity
type: feature
authors:
  - mavam
  - claude
created: 2026-07-24T00:00:00Z
---

Delegated agents are no longer unbounded. Five new budgets join the existing
limits: `maxTurns` (assistant turns per agent, default 100), `maxAgentDuration`
and `maxDuration` (wall-clock seconds per agent and per run), and `maxTokens`
and `maxCost` (input+output tokens and USD per run, enforced at turn
granularity). Exceeding a per-agent budget fails that agent with a clear error
and preserves its last streamed output as a partial result, persisted with the
run's events and shown in `/run <id>`; flow policies such as
`onError: "collect"` still apply. Exceeding a run-scoped budget fails the run
and cancels still-running agents with a distinct `budget` reason.

Long silences no longer look like hangs. The engine now consumes turn and
tool-execution events from delegated pi processes, so the live widget shows
the aggregate turn count and the running agent's current tool next to the
token counter, and replaces the output excerpt with a `no output for …` stall
hint once an agent has been silent for a minute. The `/runs` overlay shows
each running agent's current tool and last-activity age.

Note: the new `maxTurns` default (100 turns per agent) is a behavior change
for workflows that previously let agents run indefinitely; raise it via the
`budgets` tool parameter where longer investigations are intended. Two
existing defaults also loosen: `maxParallelism` rises from 4 to 8 and
`maxDepth` from 3 to 5.
