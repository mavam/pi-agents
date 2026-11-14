---
title: Agents start without waiting for MCP servers
type: change
authors:
  - mavam
created: 2026-11-14T08:21:34.851172Z
---

Agents no longer wait for your MCP servers when a session opens. Previously, resuming a session with agents could hold Pi's start for up to ten seconds while a slow server connected.

Agents of a session now get the MCP and extension tools that session had before at once, and a call of such a tool waits until its server connected, instead of failing because the server wasn't ready yet after a restart. In a new session, starting the first agents still waits up to ten seconds for your servers, as Pi's first prompt does.
