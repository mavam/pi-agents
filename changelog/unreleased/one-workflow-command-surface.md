---
title: One workflow command surface
type: change
authors:
  - mavam
  - claude
created: 2026-07-25T00:00:00Z
---

The slash-command surface collapses to the `/workflow*` nomenclature: `/runs`
and `/run` are gone. `/workflows` now browses the whole hierarchy in one
three-tier overlay — workflows with live run badges, one workflow's runs, and
one run's agents — with `⏎` drilling in and `esc` backing out. Synthetic
`all runs` and `(ad-hoc)` rows keep the global chronological view and runs
that no saved workflow claims. The plain-text run list moved to
`/workflows runs`, and the live-summary toggle to `/workflows widget`.

Run inspection moved under the singular command: `/workflow <run-id>` (with
the unchanged `result`, `agents`, `watch`, `mermaid`, and `stop` verbs)
inspects a run, while `/workflow <name>` still shows a saved workflow — a
name match wins over a run-id prefix. The overlay now discovers workflow
definitions once per open instead of on every render, so edits to workflow
files appear the next time the overlay opens.
