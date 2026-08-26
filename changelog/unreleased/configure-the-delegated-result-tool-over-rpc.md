---
title: Configure the delegated result tool over RPC
type: change
authors:
  - mavam
created: 2026-08-26T06:47:34.730455Z
---

Delegated agents now receive their result-tool configuration over Pi's RPC
channel instead of environment variables and a temporary schema file. The
spawn engine probes the child for the versioned configuration command before
sending any prompt, so a delegated Pi that is too old fails fast with a clear
"run `pi update pi`" error instead of leaking configuration into a model turn.
Extension failures inside the child now fail the workflow node immediately.
