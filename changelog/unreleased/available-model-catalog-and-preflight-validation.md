---
title: Available model catalog and preflight validation
type: feature
authors:
  - mavam
  - codex
prs:
  - 40
created: 2026-08-04T10:55:14.183846Z
---

Workflow agents now receive a catalog of models available through configured providers, and model overrides are validated before a run starts:

```json
{"kind":"agent","task":"analyze the change","model":"openai-codex/gpt-5.6-terra"}
```

Bare model IDs resolve to the first matching provider in the catalog, with subscription providers preferred. Unknown models fail before any agent spawns and report available alternatives.
