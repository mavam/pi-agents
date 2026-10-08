---
title: Durable agents replace workflows
type: breaking
authors:
  - mavam
created: 2026-10-08T09:50:49.216001Z
---

Pi-agents now gives Pi durable, named agents instead of workflows. Ask Pi to delegate, and it starts agents with `agent_spawn`, messages them with `agent_send`, and waits for them with `agent_wait`. Results of agents that Pi doesn't wait for arrive as messages in your conversation.

Agents run inside your Pi process on pi-durable and survive crashes and restarts: when you resume a session, interrupted agents continue and pending results arrive. A panel above the editor lists open agents. Attach to any agent to watch its conversation live, steer it, or keep talking to it after it answers. `/agents` browses agents and `/agent <name>` attaches.

The workflow language, saved workflows, `/workflow` and `/workflows`, event-triggered workflows, budgets, and the `pi-agents/api` extension client are gone. Agent profiles in `.pi/agents` keep working. Model notes move from `workflows.json` to `pi-agents.json`. Agents use Pi's built-in tools but not MCP servers or tools from other extensions.
