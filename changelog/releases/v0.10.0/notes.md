This release bundles the review and review-fix workflows with pi-agents, making them available in every directory while preserving project and user overrides. It also improves workflow run visibility with complete results, clearer control flow, and width-aware summaries.

## 🚀 Features

### Bundled review workflows

Installing pi-agents now makes the `review` and `review-fix` workflows available in every directory while keeping their standard YAML definitions as the package source of truth.

You can disable all bundled workflows globally:

```json
{
  "bundledWorkflows": false
}
```

Set individual workflow names in `~/.pi/agent/workflows.json` or a trusted project's `.pi/workflows.json` to override the inherited default. User and project workflow files with matching names continue to replace the bundled definitions.

*By @mavam and @codex in #34.*

## 🔧 Changes

### Compact run notification controls

The control bar under a finished run's notification is now a single glyph-prefixed usage line instead of three labelled links:

```
❖ `/workflow d1bb9fac` [result|agents]
```

The `❖` glyph comes from the shared workflow icon and marks the line as injected UI chrome rather than agent output; in TUI cards the whole line renders dim for the same reason. The base command stays inside the code span so it copies cleanly, and `result` and `agents` remain the real `/workflow` sub-commands the notation advertises.

*By @mavam and @claude in #39.*

### Consistent agent glyphs in run summaries

The live run summary above the composer now uses `✦` for agents, matching workflow trees and the fancy-footer agent counter. For example, a completed parallel trail now renders as `✦✦⑂` instead of `◆◆⑂`.

*By @mavam and @codex in #35.*

### Width-aware run summary keeps the glyph strip visible

The live run summary above the composer now adapts to the terminal width instead of truncating blindly on the right. Long workflow labels used to push the glyph strip — the most important liveness signal — off screen on narrow terminals.

The line now budgets its parts so the strip always survives. When space runs short, the least useful pieces give way first: the run id drops as soon as the full label no longer fits (it remains available in `/workflows`), then the token count, then the elapsed time. The label itself shrinks with an ellipsis toward an eight-column floor, and the output excerpt tail absorbs any final truncation as before.

```
❖ 100% · review-and-fix-the-parser · w1a2b3c4 · 1m32s · 4.5k · ✦✦⑂   (wide)
❖ 100% · review-and-fix-t… · 1m32s · 4.5k · ✦✦⑂                      (80 cols)
❖ 100% · review-a… · ✦✦⑂                                             (minimal)
```

*By @mavam and @claude in #33.*

## 🐞 Bug fixes

### Clearer workflow control flow

Exact-reference parameters now preserve their JSON type when passed into a saved workflow, enabling value-only sub-workflows to carry objects and arrays without stringifying them. Undefined frame roots normalize to `null`; mixed text and parameter defaults remain strings.

Run trees also distinguish unchosen switch arms from pending work and show loop and while rounds against their effective cap. A while loop whose initial condition is false appears as `[#0/max]`.

*By @mavam and @codex in #38.*

### Complete workflow results in cards and detail panes

Completion cards and run and agent detail panes now present complete workflow results instead of ending at fixed character limits. Terminal-sized detail panes still constrain how many rows are visible at once, and `/workflow <id> result` remains available for the complete raw value.

*By @mavam and @codex in #36.*
