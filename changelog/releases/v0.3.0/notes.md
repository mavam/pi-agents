A ground-up rewrite around an explicit workflow algebra: closed expression trees (agent, seq, par, map, loop, workflow) with explicit data bindings, saved workflow definitions, and three trigger surfaces — the model, slash commands, and pi events. Not compatible with v0.2 flow definitions or persisted run history.

## ✨ Features

### Algebraic workflow rewrite

Workflows are now closed expression trees: every node — `agent`, `seq`, `par`, `map`, `loop`, `workflow` — yields a value, `par` fuses fork and join into one expression with an inline reducer, `map` fans out dynamically over runtime arrays, and saved workflows inline like function calls with cycle detection. Data flows only through explicit references (`as` bindings, `{previous}`, `{item}`, `{params.*}`); unknown references fail validation with node paths before anything spawns. The old spawn/sequence/fork/join node tree, its implicit context injection, and v2 persisted flow events are gone.

*By @mavam.*

### Saved workflows with three trigger surfaces

Workflows can be saved as `.pi/workflows/*.md` files (frontmatter plus a fenced flow block) and fire from three surfaces: the model invokes them via the single `workflow` tool guided by `whenToUse` descriptions in the system prompt; each saved workflow auto-registers a slash command that runs the graph directly with args bound to params; and `on: [event]` frontmatter triggers background runs from pi events, with per-workflow debounce and the event payload bound as `{params.event}`. Terminology settles on **workflow** (definition) and **run** (execution): `/workflows`, `/workflow <name>`, `/runs`, and `/run <id>` with `watch`, `mermaid`, and `stop` actions replace the old `/flows` commands. Agents gain a `tools:` allowlist forwarded to the delegated process.

*By @mavam.*
