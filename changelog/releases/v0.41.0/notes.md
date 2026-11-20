Pi now starts without waiting for a resumed session's agents, agents keep the messages other agents queued for them through interrupts, and images from MCP tools fit the agent's model. This release requires Pi 1.6.0 or later and keeps an agent's wait timeout across restarts.

## 💥 Breaking changes

### Pi 1.6.0 required

pi-agents now requires Pi 1.6.0 or later, so update Pi before updating pi-agents. The update brings fixes that agents benefit from:

- Long OpenAI Codex responses no longer fail at the 60-minute WebSocket connection limit, and provider errors that report only a socket error code, such as `read ECONNRESET`, are retried.
- Agents on GPT-6.2 models keep their prompt cache across turns and thinking level changes on the `openai-codex` provider.
- Ending a Pi session while agents finish their work no longer leaves an unhandled promise rejection behind.

*By @mavam in #125.*

## 🔧 Changes

### Agents' messages survive interrupts

Interrupting an agent no longer drops the messages other agents queued for it. They stay queued and arrive with the agent's next input, since their senders can't take them back. Messages you and Pi queued are still dropped, as before, and stopping an agent still drops all of its queued messages.

*By @mavam in #127.*

### Pi starts without waiting for agents

Resuming a session with agents in Pi's terminal no longer holds Pi's start while the agents open, which could take up to ten seconds when an MCP server connected slowly. The agents open in the background and show in the panel once they did. Print, JSON, and RPC modes still wait for them, so a run sees what its agents deliver.

*By @mavam in #129.*

## 🐞 Bug fixes

### Agents' waits keep their timeout across restarts

An agent's `agent_wait` now keeps its timeout across a restart. Previously, a restart while an agent waited for its agents started the timeout over. Waits and agents' jobs also no longer occupy running work while the agents they wait for work.

*By @mavam in #128.*

### Images from MCP tools fit the agent's model

Images that tools other than `read` return to agents, such as an MCP server's screenshots or a codemode script's `image()`, are now scaled to fit the agent's model before they enter its conversation, as Pi does for its own tools. An image that can't be prepared is left out with a note. Previously, an oversized image reached the agent as it was, and the provider rejected the agent's requests from then on.

*By @mavam in #126.*
