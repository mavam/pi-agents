---
title: Wait lazily for MCP servers instead of stalling agent startup
type: change
authors:
  - mavam
created: 2026-11-21T06:25:59.543622Z
---

Opening agents no longer stalls up to ten seconds waiting for every configured MCP server to connect. Configured MCP namespaces now appear on an agent's first turn while servers connect in the background, tool calls wait lazily only for the connecting server they actually reach, and session recovery waits only for servers needed by unfinished MCP tool calls.
