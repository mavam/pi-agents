---
title: Explicit delegated agent results
type: breaking
authors:
  - mavam
  - codex
created: 2026-08-04T21:27:07.565824Z
---

Delegated agents now complete only by submitting an explicit agent result. Assistant messages remain visible as live progress but never become workflow values.

This is a breaking change for custom spawn engines, runners, and prompts:

- Replace returned `text` fields with a returned `value`.
- Provide the required result mode for each spawn.
- Remove instructions that tell delegated agents to put their result in their final assistant message. Pi-agents now supplies the result-submission contract automatically.

Text agents must submit a string, while JSON agents can submit any JSON value. An agent that settles without submitting a result fails instead of falling back to assistant prose.
