Workflow agents now validate model overrides against a provider-aware model catalog before they start, resolving bare IDs and reporting available alternatives for unknown models. The workflows and agents panels now provide taller, scrollable detail panes with keyboard navigation instead of clipping long content.

## 🚀 Features

### Available model catalog and preflight validation

Workflow agents now receive a catalog of models available through configured providers, and model overrides are validated before a run starts:

```json
{"kind":"agent","task":"analyze the change","model":"openai-codex/gpt-5.6-terra"}
```

Bare model IDs resolve to the first matching provider in the catalog, with subscription providers preferred. Unknown models fail before any agent spawns and report available alternatives.

*By @mavam and @codex in #40.*

## 🔧 Changes

### Taller, scrollable panel detail pane

The `/workflows` and `/agents` panel now budgets up to 80% of the terminal height instead of 60%, and detail longer than that budget scrolls instead of being clipped to a `… +N more lines` marker.

`⇧↑`/`⇧↓` (or `ctrl+y`/`ctrl+e`) scroll the detail pane by a line, `⇧PgUp`/`⇧PgDn` (or `ctrl+u`/`ctrl+d`) by a pane, and `⇧Home`/`⇧End` jump to either end. Plain arrows and `j`/`k` still move the table selection, so the single-letter actions keep their meaning. The footer advertises `⇧↑↓ scroll` only while something is hidden, every row keeps its own scroll offset, and a live agent tail stays pinned to the newest line until you scroll up — scrolling back to the bottom re-arms following.

The panel also renders a blank row below its closing border, so the key hints in the bottom border no longer butt against pi's status line.

*By @mavam.*
