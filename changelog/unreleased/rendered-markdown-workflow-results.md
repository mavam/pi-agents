---
title: Rendered Markdown workflow results
type: change
authors:
  - mavam
  - codex
created: 2026-07-23T20:22:46.510305Z
---

String results now render as Markdown in run inspection and completion
messages instead of appearing as fenced source text. Headings, lists, emphasis,
and code blocks produced by an agent use Pi's normal formatting in
`/run <id>`, `/run <id> result`, and per-agent results. Navigation hints and
truncation notices remain visible even when a preview cuts through a code block.
`/copy` still exposes the Markdown source, while structured values remain fenced
JSON.
