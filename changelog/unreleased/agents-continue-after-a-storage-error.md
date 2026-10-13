---
title: Agents continue after a storage error
type: bugfix
authors:
  - mavam
prs:
  - 91
created: 2026-10-13T06:36:23.721903Z
---

If writing to agent storage fails, for example because the disk is full, agents now pause, Pi tells you, and the storage reopens so agents continue as after a restart. In sessions started with `--no-session`, agents live in memory, so Pi tells you they are lost instead.
