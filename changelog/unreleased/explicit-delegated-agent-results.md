---
title: Explicit delegated agent results
type: change
authors:
  - mavam
  - codex
prs:
  - 46
created: 2026-08-04T21:27:07.565824Z
---

Delegated agents now complete by explicitly submitting their workflow value. Assistant messages remain visible as live progress but never become results, so prose surrounding a structured response can no longer break JSON workflows.

`output: text` requires a submitted string, while `output: json` accepts any JSON value directly. The result-submission mechanism remains available when `tools: []` disables all working tools. An agent that settles without an accepted submission fails instead of falling back to assistant prose.

Custom spawn engines now receive the required result mode and return the accepted `value` rather than assistant `text`.
