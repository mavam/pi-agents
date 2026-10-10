---
title: Project profiles come from the working directory
type: change
authors:
  - mavam
prs:
  - 79
created: 2026-10-10T08:16:46.137784Z
---

Project profiles now come from `.pi/agents` in the directory where you start
Pi, the same place Pi reads the project's skills and settings from. Before,
pi-agents searched parent directories for the nearest `.pi`, so a session
started in a subdirectory could pick up a profile whose project skills it
couldn't find. If you start Pi in a subdirectory and relied on the parent's
profiles, start it in the project root or move the profiles to
`~/.pi/agent/agents`.
