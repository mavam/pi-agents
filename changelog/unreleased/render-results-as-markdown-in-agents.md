---
title: Render results as Markdown in /agents
type: change
authors:
  - mavam
prs:
  - 74
created: 2026-10-09T05:27:28.563689Z
---

The detail pane of `/agents` now renders results as Markdown, so bold text, code, and lists read as they do in the conversation. A graph's detail is easier to scan: each agent gets a heading with its state, model, and spend, and its result follows indented below it. Long results end with a note on how to read the rest, and a graph shows its shape only when its agents pass results to each other.
