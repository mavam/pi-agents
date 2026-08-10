---
title: Cleaner live workflow summaries
type: change
authors:
  - mavam
  - codex
prs:
  - 54
  - 55
created: 2026-08-10T06:29:55.446054Z
---

The live workflow summary above the editor no longer shows each run's shortened UUID or a completion percentage. It now shows completed and total agents for each execution with the same `✦A/T` counter as the optional pi-fancy-footer integration:

```text
❖ review · ✦2/3 · 1m32s · 15.5k · ✦✦⑂
```

While an agent works, the summary also shows the latest provider-supplied reasoning headline exposed by Pi. Bare single-agent workflows omit the redundant trailing `✦`, while richer workflows retain their structural glyph strip. This keeps the summary compact while reporting concrete workflow state. Use `/workflows` when you need to inspect or manage a run.
