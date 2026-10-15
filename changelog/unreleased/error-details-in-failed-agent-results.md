---
title: Error details in failed agent results
type: bugfix
authors:
  - mavam
prs:
  - 99
created: 2026-10-15T06:26:30.138551Z
---

Failed agent result cards now show the available error message alongside the failure category, instead of only a label such as `model_error`. This makes provider refusals and other failures understandable without opening the agent's conversation. Long error messages collapse like answers and expand with Ctrl+O, including failures summarized in graph results. Pi still receives the full error text.
