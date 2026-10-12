---
title: Agents run codemode scripts
type: feature
authors:
  - mavam
created: 2026-10-12T09:53:27.830447Z
---

Agents can now use `codemode`, Pi's tool for JavaScript scripts that call other tools, to batch, chain, or filter tool calls in one step. Agents have it whenever it's active in your session, and a profile can name it too.

Scripts call the agent's other tools, including `delegate_graph` and `agent_send`, and each call is tracked on its own, so several delegations in one script each get their own helpers. A script interrupted by a restart continues where it was, without running its finished calls again.
