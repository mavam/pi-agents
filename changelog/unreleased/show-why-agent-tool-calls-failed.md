---
title: Show why agent tool calls failed
type: bugfix
authors:
  - mavam
created: 2026-10-09T15:27:38.326533Z
---

Agent tool calls that fail now show why in the transcript. Previously, if the
model's response broke off while it was writing a call such as `agent_send`, Pi
never ran the call, but the row looked like a normal call with no result, so it
seemed to hang. The row now shows the error, such as `terminated`, and so do
calls that fail with an error.
