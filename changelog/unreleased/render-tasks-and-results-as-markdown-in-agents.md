---
title: Render tasks and results as Markdown in /agents
type: change
authors:
  - mavam
prs:
  - 74
created: 2026-10-09T06:03:53.832062Z
---

The detail pane of `/agents` now renders tasks and results as Markdown, so bold text, code, and lists read as they do in the conversation. An agent's task and its result each sit below a divider that names them, like the one under the table. The divider says "Result" while the answer replies to the task above it, and "Latest result" once the agent answered later messages.

A graph's detail is easier to scan: when its agents pass results to each other, it says the order in words, such as "Runs map, then api and tests at once, then merge." Each agent then gets a heading with its state, model, and spend, and its result follows indented below it. Long tasks and results end with a note on how to read the rest.
