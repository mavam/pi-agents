Build more predictable workflows with deterministic switch and value nodes, comprehensive execution budgets, and richer live activity. Workflow results now render as Markdown, while explicit opt-in prevents unintended delegation.

## 🚀 Features

### Data-driven routing with switch nodes

Workflows can now branch deterministically without burning an agent on the decision. The new `switch` node names a JSON value with `on: "{binding}"` (exactly like `map.over`), tries its `cases` predicates in definition order, and runs the first matching arm — or the mandatory `else`. Exactly one arm executes, and its value becomes the switch's value, so downstream references never dangle:

```yaml
kind: switch
on: "{gate}"
cases:
  - when: { eq: ["status", "approved"] }
    then: { kind: agent, name: shipper, task: "Ship it" }
  - when: { exists: "findings" }
    then: { kind: agent, name: fixer, task: "Fix {gate.findings}" }
else: { kind: agent, name: reporter, task: "Report {gate.outcome}" }
```

Predicates are the same total language as `loop.until`. Flow trees render the node as `⎇` with one line per arm, Mermaid diagrams draw a decision diamond with labeled edges, and run inspection lights up only the arm that ran.

*By @mavam and @claude in #15.*

### Execution budgets and live activity

Delegated agents are no longer unbounded. Five new budgets join the existing limits: `maxTurns` (assistant turns per agent, default 100), `maxAgentDuration` and `maxDuration` (wall-clock seconds per agent and per run), and `maxTokens` and `maxCost` (input+output tokens and USD per run, enforced at turn granularity). Exceeding a per-agent budget fails that agent with a clear error and preserves its last streamed output as a partial result, persisted with the run's events and shown in `/run <id>`; flow policies such as `onError: "collect"` still apply. Exceeding a run-scoped budget fails the run and cancels still-running agents with a distinct `budget` reason.

Long silences no longer look like hangs. The engine now consumes turn and tool-execution events from delegated pi processes, so the live widget shows the aggregate turn count and the running agent's current tool next to the token counter, and replaces the output excerpt with a `no output for …` stall hint once an agent has been silent for a minute. The `/runs` overlay shows each running agent's current tool and last-activity age.

Note: the new `maxTurns` default (100 turns per agent) is a behavior change for workflows that previously let agents run indefinitely; raise it via the `budgets` tool parameter where longer investigations are intended. Two existing defaults also loosen: `maxParallelism` rises from 4 to 8 and `maxDepth` from 3 to 5.

*By @mavam and @claude in #14.*

### Pure data leaves with value nodes

The new `value` node yields a template-interpolated JSON value without spawning an agent. A string that is exactly one `{reference}` substitutes the referenced JSON value itself — type preserved — while mixed strings interpolate as text:

```yaml
kind: value
value:
  files: "{scout.files}"        # the array itself, not a string
  summary: "saw {scout.count}"  # interpolates as text
  reviewed: true
```

Use it to shape outcomes or as a `switch` arm that returns an existing binding — previously that required an agent whose only job was to echo.

*By @mavam and @claude in #15.*

## 🔧 Changes

### Footer widget names in the footer's own style

The two pi-fancy-footer counters contributed by pi-agents now use the footer's own naming style. They appear as `workflows` and `agents` in `/fancy-footer` instead of `Active workflows` and `Agent progress`, so they line up with built-in widget names like `branch`, `pr-ci`, and `cache-hit`.

*By @mavam and @claude in #17.*

### Rendered Markdown workflow results

String results now render as Markdown in run inspection and completion messages instead of appearing as fenced source text. Headings, lists, emphasis, and code blocks produced by an agent use Pi's normal formatting in `/run <id>`, `/run <id> result`, and per-agent results. Navigation hints and truncation notices remain visible even when a preview cuts through a code block. `/copy` still exposes the Markdown source, while structured values remain fenced JSON.

*By @mavam and @codex.*

### Workflows only run when you ask for one

The `workflow` tool no longer starts runs you did not ask for. It is now explicitly opt-in, and it takes an affirmative request to run something — "run the review workflow", "delegate this", "spawn agents for these", "do these in parallel" — or a saved workflow you ask for by name or by the situation its `trigger` declares. Merely saying *workflow* or *flow* is not a request, and neither is asking about a saved workflow or editing one.

Everything else it does itself. The gate spells out the cases that used to produce unwanted delegation — a large multi-step task, a long list of independent items, a multi-file refactor, a review, an audit, a research question, or anything the model privately judged parallelizable — and states that none of them is a trigger. When a workflow really is the better tool but you did not ask for one, you get the work plus a one-line mention that a workflow could take it, instead of a background run.

The tool also only ever starts runs, so it is no longer reached for on an existing one: a live agent is corrected with `steer`, and a run is inspected or stopped with `/run`.

The `<workflows>` catalog in the system prompt carries the same framing: it is a reference, not an invitation, so a saved workflow merely existing for a task is never by itself a reason to run one.

*By @mavam and @claude in #16.*
