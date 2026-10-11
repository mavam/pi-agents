---
title: Deliver agent results without truncation
type: change
authors:
  - mavam
created: 2026-10-11T19:04:55.915162Z
---

Agent results now reach Pi whole. Graph result messages, `agent_wait` results, and codemode scripts' `result` and `error` fields are no longer cut at 40,000 characters, and the `truncated` field is gone. Agents likewise see every job in `agent_status` and the full graph result from `delegate_graph`.
