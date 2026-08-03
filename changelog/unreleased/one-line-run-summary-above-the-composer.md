---
title: One-line run summary above the composer
type: change
authors:
  - mavam
  - claude
prs:
  - 32
created: 2026-08-03T11:37:45.40805Z
---

The live run summary above the composer now uses one line per run instead of
two. The former segment line collapses into a compact glyph strip at the end
of the stats line:

```
⠴ 25% · Quick test workflow · 5fa27283 · 0m09s · 19.1k · ◆⑃⇶↺
```

Each top-level unit contributes one kind glyph — `◆` for agents, `≡ ⑃ ⇶ ↺ ⎇ ≔
❖` for structural nodes, and `⑂` for parallel reducers — colored by status:
dim while pending, yellow while running, green when completed. Failed units
render `✗` instead of their kind glyph, so failures stay visible even without
color.

The strip also zooms into wherever the run is active: a running composite
expands its children in dim `⟨…⟩` brackets, recursively along the active
spine, while completed and pending units stay collapsed. Map items and loop
iterations show as one glyph per instance, capped at eight with an ellipsis,
so wide fan-outs never flood the line:

```
⠴ 55% · Quick test workflow · 5fa27283 · 0m21s · 48.2k · ◆⑃⇶⟨◆◆◆⟩↺
```

The summary also drops the aggregate turn count: turns summed across
concurrent agents with independent conversations carried no meaning, and the
token count already conveys activity volume. Per-agent turn counts remain
available in `/workflows`.

The strip shows the workflow's shape and locus of activity at a glance while
halving the widget's vertical footprint; full per-node detail remains
available in `/workflows`.
