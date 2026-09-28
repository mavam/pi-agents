---
title: Fix delegated pi spawn on Windows
type: bugfix
authors:
  - divingyu
created: 2026-09-28T07:14:31Z
---

Delegated agent subprocesses now launch through the running interpreter
(`process.execPath` plus the CLI entry from `process.argv[1]`) instead of a
bare `pi` command. On Windows, the npm-installed `pi` bin is a `.cmd` shim
that `child_process.spawn` cannot resolve with `shell: false`, which made
every delegated workflow node fail with `spawn pi ENOENT`. A bare `pi`
remains the fallback when no JS entry can be identified, e.g. for
single-executable builds.
