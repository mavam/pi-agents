pi-agents now requires Pi 1.6.1 or later. Shared extensions that override built-in tools now follow each agent's built-in tool allowlist, including when agents spawn helpers.

## 💥 Breaking changes

### Pi 1.6.1 required

pi-agents now requires Pi 1.6.1 or later, so update Pi before updating pi-agents. The update brings fixes that agents benefit from:

- Agents on Windows find Git for Windows installations outside Program Files instead of falling back to the WSL launcher.
- Large lines, MCP Streamable HTTP events, and provider SSE streams are read in linear time instead of stalling on multi-megabyte payloads.
- Agents pick up Pi 1.6.1's model and retry fixes, including `xhigh` thinking on Gemini 4 Hydrogen and Neon, Claude 5.5 thinking `off` on Copilot and gateways, GPT-6 Codex effort and WebSocket replay fixes, and GitHub Copilot and Radius decision models in `codemode` scripts.

*By @mavam in #136.*

## 🐞 Bug fixes

### Shared extension overrides of built-in tools

Shared extensions listed in `piAgents.twinExtensions` that override built-in tool names (such as `pi-hashline-edit-pro`'s `read` and `grep`) are no longer stripped from agents. Overridden tools now follow the agent's built-in tool allowlist—including when agents spawn helpers—while keeping the shared implementation, its prompt guidance, and ambient skill discovery.

*By @sunnysab in #134.*
