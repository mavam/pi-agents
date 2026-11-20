---
title: Pi 1.6.0 required
type: breaking
authors:
  - mavam
created: 2026-11-14T08:21:35.629312Z
---

pi-agents now requires Pi 1.6.0 or later, so update Pi before updating pi-agents. The update brings fixes that agents benefit from:

- Long OpenAI Codex responses no longer fail at the 60-minute WebSocket connection limit, and provider errors that report only a socket error code, such as `read ECONNRESET`, are retried.
- Agents on GPT-6.2 models keep their prompt cache across turns and thinking level changes on the `openai-codex` provider.
- Ending a Pi session while agents finish their work no longer leaves an unhandled promise rejection behind.
