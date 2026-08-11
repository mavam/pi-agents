Pi Agents gives the model dedicated tools to create, list, inspect, retrieve, steer, and stop workflow runs. Live summaries now stay compact while surfacing agent progress and recent activity.

## 💥 Breaking changes

### Directed model tools for workflow runs

The model can now manage workflow runs without asking you to relay `/workflow` command output:

- `workflow_create`: Start a saved workflow or inline flow.
- `workflow_list`: List recent persisted runs from the current session.
- `workflow_inspect`: Inspect a run's status, live tree, progress, usage, errors, and exact node instances.
- `workflow_result`: Retrieve paginated run or node results, optionally selecting a smaller value by dot path.
- `workflow_steer`: Queue a course correction for a live node.
- `workflow_stop`: Stop a live run after you explicitly request cancellation.

Large persisted results remain recoverable through repeated `workflow_result` calls with `nextCursor`.

*By @mavam in #56.*

## 🔧 Changes

### Cleaner live workflow summaries

The live workflow summary above the editor no longer shows each run's shortened UUID or a completion percentage. It now shows completed and total agents for each execution with the same `✦A/T` counter as the optional pi-fancy-footer integration:

```text
❖ review · ✦2/3 · 1m32s · 15.5k · ✦✦⑂
```

While an agent works, the summary also shows its latest activity, choosing between Pi's provider-supplied reasoning headline and the active tool by recency. Every activity label remains visible for at least three seconds and stays in place until a newer one arrives, with rapid updates coalesced to the newest one. Long silences appear as `no activity for …`. Bare single-agent workflows omit the redundant trailing `✦`, while richer workflows retain their structural glyph strip. This keeps the summary compact while reporting concrete workflow state. Use `/workflows` when you need to inspect or manage a run.

*By @mavam and @codex in #54 and #55.*
