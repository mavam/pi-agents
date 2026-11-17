---
title: Images from MCP tools fit the agent's model
type: bugfix
authors:
  - mavam
prs:
  - 124
created: 2026-11-17T05:34:49.277558Z
---

Images that tools other than `read` return to agents, such as an MCP server's screenshots or a codemode script's `image()`, are now scaled to fit the agent's model before they enter its conversation, as Pi does for its own tools. An image that can't be prepared is left out with a note. Previously, an oversized image reached the agent as it was, and the provider rejected the agent's requests from then on.
