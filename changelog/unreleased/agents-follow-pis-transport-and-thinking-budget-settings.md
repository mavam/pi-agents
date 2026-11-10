---
title: Agents follow Pi's transport and thinking budget settings
type: bugfix
authors:
  - mavam
prs:
  - 122
created: 2026-11-10T08:29:19.359648Z
---

Agents now follow more of your Pi settings for model requests: `transport`, for example `"websocket"`, `websocketConnectTimeoutMs`, and `thinkingBudgets`. Previously, agents used the provider defaults regardless of these settings.
