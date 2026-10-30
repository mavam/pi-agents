---
title: Agent guidance keeps the prompt cache
type: bugfix
authors:
  - Haichiu
prs:
  - 118
created: 2026-10-26T13:30:00.000000Z
---

The agent guidance in Pi's system prompt is now a prompt section instead of a replaced system prompt. Before, a change to any other part of the prompt during a session, such as MCP servers that finish connecting, changed the leading system prompt and made the provider write the whole conversation to its prompt cache again. Now Pi adds only a small update, and the cached conversation stays valid.
