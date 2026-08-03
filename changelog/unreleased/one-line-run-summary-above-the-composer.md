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
⠴ 25% · Quick test workflow · 5fa27283 · 0m09s · 19.1k · 3 turns · ◆⑃⇶↺
```

Each depth-1 unit contributes one kind glyph — `◆` for agents, `≡ ⑃ ⇶ ↺ ⎇ ≔ ❖`
for structural nodes, and `⑂` for parallel reducers — colored by status: dim
while pending, yellow while running, green when completed. Failed units render
`✗` instead of their kind glyph, so failures stay visible even without color.
The strip shows the workflow's shape at a glance while halving the widget's
vertical footprint; full per-node detail remains available in `/workflows`.
