Pi-agents is now a rewrite that runs durable, named agents on pi-durable inside your Pi process. Agents checkpoint every step, so they survive crashes and resume where they left off.

## 💥 Breaking changes

### Rewrite pi-agents on pi-durable

Pi-agents is a rewrite: it now gives Pi durable, named agents instead of workflows, and runs them inside your Pi process on [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable). Every agent step is checkpointed, so agents survive crashes and restarts. When you resume a session, interrupted agents continue and results that haven't arrived yet post into your conversation.

Ask Pi to delegate, and it works with agents through `agent_spawn`, `agent_send`, `agent_wait`, `agent_status`, and `agent_stop`. An agent's result is its final message. Results that Pi doesn't wait for arrive later as messages, and agents leave the panel once their answer reaches Pi.

A panel above the editor shows working, failed, and interrupted agents. Attach to any agent to watch its conversation live, steer it, or keep talking to it, including agents that already finished: `/agents` lists every agent and `/agent <name>` attaches directly.

The workflow language, saved and event-triggered workflows, `/workflow` and `/workflows`, budgets, and the `pi-agents/api` extension client are gone. Agent profiles in `.pi/agents` keep working. Model notes in `workflows.json` are gone: models resolve like `pi --model`, so `sonnet` picks the newest Sonnet. Agents use Pi's built-in tools but not yet MCP servers or tools from other extensions.

*By @mavam in #69.*
