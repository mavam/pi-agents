This release unifies workflow browsing and run inspection under the /workflow command surface. It also improves overlay sizing, completion summaries, and safeguards for pure-data workflow budgets.

## 🔧 Changes

### Clearer workflow completion summaries

Workflow completion notifications now use pi-agents' workflow and status icon language, with theme-aware colors for completed, failed, and stopped runs:

```text
❖ review · 9a7eb000 · ● completed · 3 turns ↑12k ↓4k · 4 agents
```

The compact headline keeps the workflow name, run ID, outcome, and usage together while presenting inspection commands and the result as separate, readable sections.

*By @mavam and @codex in #20.*

### One workflow command surface

The slash-command surface collapses to the `/workflow*` nomenclature: `/runs` and `/run` are gone. `/workflows` now browses the whole hierarchy in one three-tier overlay — workflows with live run badges, one workflow's runs, and one run's agents — with `⏎` drilling in and `esc` backing out. Synthetic `all runs` and `(ad-hoc)` rows keep the global chronological view and runs that no saved workflow claims. The plain-text run list moved to `/workflows runs`, and the live-summary toggle to `/workflows widget`.

Run inspection moved under the singular command: `/workflow <run-id>` (with the unchanged `result`, `agents`, `watch`, `mermaid`, and `stop` verbs) inspects a run, while `/workflow <name>` still shows a saved workflow — a name match wins over a run-id prefix. The overlay now discovers workflow definitions once per open instead of on every render, so edits to workflow files appear the next time the overlay opens.

*By @mavam and @claude in #18.*

### Zero-agent workflow budgets

Pure-data workflows can now set `maxAgents: 0` to guarantee that a run does not execute agents or reducers:

```json
{
  "flow": { "kind": "value", "value": "done" },
  "budgets": { "maxAgents": 0 }
}
```

Value and structural nodes continue to run normally. If an executed branch reaches an agent, the run fails before starting its subprocess. The workflow tool also exposes each budget's valid range, unit, and default to prevent invalid model-generated arguments.

*By @mavam and @codex in #19.*

## 🐞 Bug fixes

### Elastic overlay height

The interactive overlay now sizes itself to its content up to the full terminal height. Previously a fixed 85% height cap sliced the rendered box from the bottom on terminals taller than ~27 rows, silently eating the footer and the tail of the detail pane. The cap is gone: the overlay budgets its own height from the terminal, grows downward as the detail pane fills, and always ends with the key-hint footer — long details are truncated explicitly with a `… +N more lines` marker instead of being cut mid-box.

*By @mavam and @claude in #18.*
