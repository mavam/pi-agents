---
title: Configure the delegated result tool over RPC
type: change
authors:
  - mavam
created: 2026-08-26T06:47:34.730455Z
---

Delegated agents now receive their result-tool configuration over Pi's RPC
channel instead of environment variables and a temporary schema file.
Extension failures inside the child now fail the workflow node immediately.
