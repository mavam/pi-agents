Agent invocations can now select their own skills and tools, making one-off delegation fully configurable without creating profiles. Workflow and agent browsers also open directly above the composer for easier access and monitoring.

## 🚀 Features

### Per-call skills and execution configuration

Any agent invocation can now select its own skills and tools, whether or not it names a profile. Skills used to be reachable only by writing an agent file, which pushed you into creating a profile for a one-off delegation:

```json
{ "kind": "agent", "task": "Review the diff in src/run", "skills": ["code-review"] }
```

A named call inherits its profile's skills when `skills` is omitted, and an explicit list replaces the profile's rather than adding to it — so `skills: ["gh"]` swaps the list and `skills: []` clears it. `tools` behaves the same way, with `[]` still meaning no tools at all. Reducers gained the full option set too (`model`, `thinking`, `skills`, `tools`, `cwd`, `scope`), and the flat saved-workflow form normalizes all of them, so the same configuration is expressible in an inline flow, a saved flow tree, a flat workflow, and a reducer.

An unresolvable skill is now a configuration error rather than a silent omission. Previously a stale name appended a `Missing skills (not found)` line to the delegated prompt and the agent ran anyway; now the run fails during preflight, before anything spawns, naming the node and what was available:

```
cannot start run: at $.steps[1], unknown skill 'code-reveiw'
(cwd: /repo, scope: project). Available: code-review, gh
```

Skills resolve from the same catalog pi advertises in `<available_skills>`, in the same precedence order: `<project>/.pi/skills` and `.agents/skills` from the cwd up to the git root, then `~/.pi/agent/skills` and `~/.agents/skills`, with the first definition of a name winning. Discovery follows `scope` exactly as profile discovery does, so an untrusted project — clamped to user scope — contributes no skills.

All project resources now resolve from one project root, the nearest ancestor of the cwd holding a `.pi` directory; profiles, skills, and workflows previously walked up independently, which let a run combine a parent project's profile with a nested project's skills.

*By @mavam and @claude in #24.*

## 🔧 Changes

### Workflow and agent browsers at the composer

The `/workflows` and `/agents` browsers now open in place of the composer instead of floating near the top of the terminal, matching where pi shows `/settings` and `/model`.

On tall or vertical terminals the split pane previously appeared a screenful away from where you were typing, so it was easy to miss entirely. It now opens directly above the input you just typed into. The panel caps itself at roughly 60% of the terminal height to keep the conversation visible above it, and `esc` closes it and restores the composer as before.

The live run summary now also hides itself while the workflows panel is open, since that panel sits directly below it and already reports the same run state. It remains visible in the agents panel, which doesn't show run state. The summary comes back when you close the workflows panel, and both `/workflows widget` and per-run `h` choices are preserved.

Pressing `r` on a workflow row keeps the panel open too, so you can watch the run you just started instead of being dropped back at the composer. This matches `r` on a run row, which already stayed open when rerunning.

*By @mavam and @claude in #23.*
