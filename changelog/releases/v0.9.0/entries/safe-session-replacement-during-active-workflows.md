---
title: Safe session replacement during active workflows
type: bugfix
authors:
  - mavam
  - codex
prs:
  - 31
created: 2026-08-03T11:27:25.100175Z
---

Starting, switching, forking, or reloading a session no longer crashes Pi while a workflow is running. The live workflow summary now shuts down cleanly with the session.
