---
title: Pi 1.6.1 required
type: breaking
authors:
  - mavam
prs:
  - 136
created: 2026-11-26T07:22:18.507172Z
---

pi-agents now requires Pi 1.6.1 or later, so update Pi before updating pi-agents. The update brings fixes that agents benefit from:

- Agents on Windows find Git for Windows installations outside Program Files instead of falling back to the WSL launcher.
- Large lines, MCP Streamable HTTP events, and provider SSE streams are read in linear time instead of stalling on multi-megabyte payloads.
- Agents pick up Pi 1.6.1's model and retry fixes, including `xhigh` thinking on Gemini 4 Hydrogen and Neon, Claude 5.5 thinking `off` on Copilot and gateways, GPT-6 Codex effort and WebSocket replay fixes, and GitHub Copilot and Radius decision models in `codemode` scripts.
