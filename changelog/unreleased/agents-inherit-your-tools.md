---
title: Agents inherit your tools
type: change
authors:
  - mavam
prs:
  - 91
created: 2026-10-12T15:38:28.791336Z
---

Agents now start with the tools you have active in Pi, instead of always `read`, `bash`, `edit`, and `write`. With `codemode` or `grep` active in your session, agents get them too, and their helpers inherit the agent's tools. Tools that agents can't run, such as MCP and other extensions' tools, are left out. A profile or a spawn that names tools still decides on its own.
