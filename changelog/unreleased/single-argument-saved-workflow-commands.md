---
title: Single-argument saved workflow commands
type: change
authors:
  - mavam
  - codex
prs:
  - 49
created: 2026-08-05T09:44:30.64127Z
---

Saved-workflow slash commands now pass all text after the command name to the first declared parameter:

```text
/review this pull request
```

The example binds `this pull request` to `target`; multiword values no longer need quotes. Slash commands no longer parse positional values or `key=value` pairs. Use the model-facing `workflow` tool or RPC when you need to supply multiple named parameters. A required parameter after the first must define a default for direct slash-command invocation.

The workflows panel now keeps workflows that need additional named parameters open and points you to those structured invocation paths instead of composing a slash command that cannot run.
