---
title: Delegated agents are told their final message is the result
type: change
authors:
  - mavam
  - claude
prs:
  - 6
created: 2026-07-23T10:24:31Z
---

An agent's value has always been the text of its last assistant
message — but nothing told the agent that. Every delegated agent
(ad-hoc ones included) now receives a delegation preamble in its system
prompt: the run is non-interactive, only the final message is returned,
so end the turn with one dedicated message containing the complete
deliverable. With `output: json`, the preamble additionally requests a
single raw JSON value, which was previously enforced only by failing
the node when parsing choked. The value contract is also documented in
the README's `agent` node reference.
