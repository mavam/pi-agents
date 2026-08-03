Pi agents now support bounded, pre-checked while iterations that safely carry JSON state through workflows. The release also makes workflow results easier to read, compresses live run summaries, and safely handles session replacement during active workflows.

## 🚀 Features

### Bounded pre-checked iteration

Workflows can now use a bounded, pre-checked `while` node to carry JSON state through zero or more iterations:

```yaml
kind: while
on: "{initial_state}"
condition:
  eq: [status, pending]
max: 3
body:
  kind: agent
  task: "Advance {current} in round {iteration}."
  output: json
```

The node checks `condition` before each iteration, exposes the carried value as `{current}` and the zero-based round as `{iteration}`, and returns the final carried value. The required `max` cap and the workflow iteration budget bound execution even when the condition never becomes false.

*By @mavam, @claude, and @codex in #25.*

### Human-readable structured workflow results

Structured workflows can now present a human-readable Markdown result without giving up their machine-readable value. Set `display` to the dot path of the Markdown field:

```yaml
name: review
display: report
```

Completion cards and run details render the complete selected string, while parent workflows and `/workflow <id> result` retain the original structured value. A missing or non-string display path falls back to the raw result.

*By @mavam and @codex in #25.*

## 🔧 Changes

### One-line run summary above the composer

The live run summary above the composer now uses one line per run instead of two. The former segment line collapses into a compact glyph strip at the end of the stats line:

```
❖ 25% · Quick test workflow · 5fa27283 · 0m09s · 19.1k · ◆⑃⇶↺
```

Each top-level unit contributes one kind glyph — `◆` for agents, `≡ ⑃ ⇶ ↺ ⎇ ≔ ❖` for structural nodes, and `⑂` for parallel reducers — colored by status: dim while pending, yellow while running, green when completed. Failed units render `✗` instead of their kind glyph, so failures stay visible even without color.

The strip also zooms into wherever the run is active: a running composite expands its children in dim `⟨…⟩` brackets, recursively along the active spine, while completed and pending units stay collapsed. Map items and loop iterations show as one glyph per instance, capped at eight with an ellipsis, so wide fan-outs never flood the line:

```
❖ 55% · Quick test workflow · 5fa27283 · 0m21s · 48.2k · ◆⑃⇶⟨◆◆◆⟩↺
```

The animated braille spinner gives way to the static ❖ run mark that completion cards and notifications already use: liveness now shows through the yellow glyphs in the strip, so nothing needs to flicker, and the fixed one-cell mark keeps the line's left edge stable while the percent grows.

The summary also drops the aggregate turn count and the current tool: turns summed across concurrent agents carried no meaning, and the tool belonged to whichever agent started most recently, without attribution — its variable-width name ahead of the status glyphs also shifted them on every tool switch. The token count already conveys activity volume, and per-agent turns and tools remain visible in `/workflows`.

The strip shows the workflow's shape and locus of activity at a glance while halving the widget's vertical footprint; full per-node detail remains available in `/workflows`.

*By @mavam and @claude in #32.*

## 🐞 Bug fixes

### Safe session replacement during active workflows

Starting, switching, forking, or reloading a session no longer crashes Pi while a workflow is running. The live workflow summary now shuts down cleanly with the session.

*By @mavam and @codex in #31.*
