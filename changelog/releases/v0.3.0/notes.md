Build reusable, data-driven agent workflows and run them from the model, slash commands, or event hooks. Inspect and manage every workflow and run from new interactive TUI overlays, with live progress at a glance.

## 🚀 Features

### Algebraic workflow rewrite

Workflows are now closed expression trees: every node — `agent`, `seq`, `par`, `map`, `loop`, `workflow` — yields a value, `par` fuses fork and join into one expression with an inline reducer, `map` fans out dynamically over runtime arrays, and saved workflows inline like function calls with cycle detection. Data flows only through explicit references (`as` bindings, `{previous}`, `{item}`, `{params.*}`); unknown references fail validation with node paths before anything spawns. The old spawn/sequence/fork/join node tree, its implicit context injection, and v2 persisted flow events are gone.

*By @mavam.*

### Icon trees for reading flows

Flows render as compact icon trees everywhere they are displayed: `✦` agent, `⑃` parallel with `⑂` reduce, `⇶` map, `↺` loop, `❖` workflow, with sequences transparent and task previews inline. The tool call display shows the tree instead of raw JSON arguments, `/workflow <name>` shows the tree above the JSON definition, and `/run <id>` overlays live status icons (`○ ◉ ● ✗ ⊘`) on the same skeleton, aggregating map items and loop iterations in place (`[3/5]`). In the tool-call render the tree is colored dataflow-first: every `{reference}` and binding in theme accent, prose and connectors dim, kind glyphs muted — structure and data plumbing are separable at a glance. The JSON/YAML form remains the canonical authoring syntax.

*By @mavam.*

### Interactive /runs and /workflows overlays

`/runs`, `/workflows`, and `/agents` now open a keyboard-navigable split-pane overlay in the TUI: a table of one-line entries on top, the selected item below — the flow tree with dataflow coloring (`{refs}` in accent) plus full metadata: file, triggers, and params for workflows; file, model, thinking, skills, and tools for agents — refreshing live while runs execute. The overlay is pinned near the top of the screen and the detail pane only ever grows, so the table never shifts while browsing. `↑`/`↓` (or `j`/`k`) move the selection, `esc` closes, and single-letter actions operate on the selected row — runs: `⏎` inspect with the full result, `c` cancel, `r` rerun, `h` show/hide the run in the live summary widget; workflows: `⏎` compose `/<name> ` in the editor, `r` run; agents: `⏎` inspect. `n` (workflows/agents) creates a new definition: you name it, the model drafts the file. `list` keeps the plain markdown output (always used in non-TUI modes), and `/runs widget` toggles the live run summary above the composer.

*By @mavam.*

### Live two-line run widget

The above-editor widget now shows two theme-colored lines per live run: an animated braille spinner with the completion percentage (over known agents — the denominator grows as map items are discovered), the label, dim run id, elapsed time, a live token counter fed by streaming usage, and the active agent's latest output excerpt dimmed to the end of the line (ANSI-aware truncation at terminal width); below it, one status-iconed segment per top-level step, with composite phases collapsed to their kind glyph and aggregate agent counts (`● explorer → {map}   ◉ ⑃ par [2/4]   ○ ⇶ map   ○ ↺ loop`). The full vertical structure lives in the tool-call render — the workflow tool shows the icon tree of the flow and a single status line (`◉ running in background · /run <id>`) with no duplicated label or id — while the widget stays a horizontal live pulse. The animation timer runs only while runs are active and is disposed on shutdown.

*By @mavam.*

### Pure-data workflows and reusable task units

Workflow files are pure data now: one YAML or JSON object per file, with the extension deciding the parser (.yaml, .yml, .json) and prose living in an optional doc: key. The earlier markdown/frontmatter form is gone. Single-unit workflows can skip the graph entirely with the flat form — `agent:` plus optional `task:`, `model:`, `thinking:` — which normalizes to a bare agent leaf while keeping full workflow powers (params, slash command, hooks, cross-workflow references) — the flat workflow is the one named, reusable agent+task unit, while agent files stay purely personas (who: system prompt, model, thinking, tools, skills). Agent nodes accept `model:`/`thinking:` overrides with the precedence flow node → agent file → active session.

*By @mavam.*

### Saved workflows with three trigger surfaces

Workflows can be saved as pure YAML/JSON files (`.pi/workflows/*.yaml`, the extension decides the parser) and fire from three surfaces: the model invokes them via the single `workflow` tool guided by `trigger` descriptions in the system prompt; each saved workflow auto-registers a slash command that runs the graph directly with args bound to params; and `on: [event]` frontmatter triggers background runs from pi events, with per-workflow debounce and the event payload bound as `{params.event}`. Terminology settles on **workflow** (definition) and **run** (execution): `/workflows`, `/workflow <name>`, `/runs`, and `/run <id>` with `watch`, `mermaid`, and `stop` actions replace the old `/flows` commands. Agents gain a `tools:` allowlist forwarded to the delegated process.

*By @mavam.*

## 🐞 Bug fixes

### Fence run result previews

Run-completed notifications spliced the raw result preview into their markdown, so JSON values were reflowed into a mangled blob by the renderer. Previews are now wrapped in a code fence that grows past any backtick runs embedded in the value; `/run <id>` details and `/run <id> result` use the same fencing, fixing results that contain triple backticks themselves.

*By @mavam.*

### Review hardening and correctness fixes

Run events now persist to a sidecar file (`<session>.pi-agents.jsonl`) instead of being appended into the session file, which could fork pi's session tree on reload. The extension targets pi ≥ 0.80 and honors its project-trust decision: untrusted projects contribute no agents, workflows, commands, or hooks, and project-scope overrides clamp to user scope. Hooks never install in delegated child processes, and `session_start` hooks see their own trigger. Preflight resolves agents with each node's effective cwd/scope; agents without frontmatter inherit the active session's model and thinking; an explicit `tools: []` now means no tools (`--no-tools`) instead of all tools; `maxParallelism` is enforced globally across nested pools and effective budget limits propagate to children via `PI_AGENTS_BUDGETS`; budget values are validated as positive integers; and full run results are retrievable with `/run <id> result` while model-facing tool output is bounded.

*By @mavam.*

### User scope moves under ~/.pi/agent

User-scope agents and workflows now live inside pi's agent directory — `~/.pi/agent/agents` and `~/.pi/agent/workflows` — matching pi's own conventions for skills, prompts, and tools instead of the previous `~/.pi/agents`/`~/.pi/workflows` siblings. This also makes the `PI_CODING_AGENT_DIR` override apply to pi-agents resources wholesale, and fixes the project-skills exclusion check to compare against pi's actual user-skills location (`~/.pi/agent/skills`).

*By @mavam.*
