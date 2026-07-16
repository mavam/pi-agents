A ground-up rewrite around an explicit workflow algebra: closed expression trees (agent, seq, par, map, loop, workflow) with explicit data bindings, saved workflow definitions, and three trigger surfaces — the model, slash commands, and pi events. Not compatible with v0.2 flow definitions or persisted run history.

## ✨ Features

### Algebraic workflow rewrite

Workflows are now closed expression trees: every node — `agent`, `seq`, `par`, `map`, `loop`, `workflow` — yields a value, `par` fuses fork and join into one expression with an inline reducer, `map` fans out dynamically over runtime arrays, and saved workflows inline like function calls with cycle detection. Data flows only through explicit references (`as` bindings, `{previous}`, `{item}`, `{params.*}`); unknown references fail validation with node paths before anything spawns. The old spawn/sequence/fork/join node tree, its implicit context injection, and v2 persisted flow events are gone.

*By @mavam.*

## 🐞 Bug fixes

### Review hardening and correctness fixes

Run events now persist to a sidecar file (`<session>.pi-agents.jsonl`) instead of being appended into the session file, which could fork pi's session tree on reload. Project-local hook workflows require a one-time interactive confirmation before auto-running, hooks never install in delegated child processes, and `session_start` hooks see their own trigger. Preflight resolves agents with each node's effective cwd/scope; agents without frontmatter inherit the active session's model and thinking; an explicit `tools: []` now means no tools (`--no-tools`) instead of all tools; `maxParallelism` is enforced globally across nested pools and effective budget limits propagate to children via `PI_AGENTS_BUDGETS`; budget values are validated as positive integers; and full run results are retrievable with `/run <id> result` while model-facing tool output is bounded.

*By @mavam.*

### Saved workflows with three trigger surfaces

Workflows can be saved as `.pi/workflows/*.md` files (frontmatter plus a fenced flow block) and fire from three surfaces: the model invokes them via the single `workflow` tool guided by `whenToUse` descriptions in the system prompt; each saved workflow auto-registers a slash command that runs the graph directly with args bound to params; and `on: [event]` frontmatter triggers background runs from pi events, with per-workflow debounce and the event payload bound as `{params.event}`. Terminology settles on **workflow** (definition) and **run** (execution): `/workflows`, `/workflow <name>`, `/runs`, and `/run <id>` with `watch`, `mermaid`, and `stop` actions replace the old `/flows` commands. Agents gain a `tools:` allowlist forwarded to the delegated process.

*By @mavam.*
