# 🤖 pi-agents

A generic framework for agent orchestration in
[pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent).

## 📦 Install

```bash
pi install npm:pi-agents
```

Where agents are loaded from:

- **User agents:** `~/.pi/agents/*.md`
- **Project agents:** nearest `.pi/agents/*.md` (searched upward from your current working directory)

The tool defaults to **both** (project + user) agents.

## 🚀 Quick start

### 1. Create an agent file

For example `.pi/agents/explorer.md` in your project:

```md
---
# Name used when you delegate: "Use agent explorer ..."
name: explorer
# Short description shown in agent lists
description: Fast codebase exploration
# Use provider/model from /model for deterministic routing
model: openai-codex/gpt-5.3-codex-spark
# Thinking level: off|minimal|low|medium|high|xhigh
thinking: low
# Optional skills to inject into the delegated run
skills:
  - search
---

Find the relevant files and APIs quickly.
Return a compact handoff with concrete file paths.
```

Everything below the frontmatter is the agent's system prompt.

### 2. Start Pi

```sh
pi
```

This repo already includes project-local examples in `.pi/agents/` (`explorer`, `worker`).

### 3. Spawn an agent

Ask naturally:

- `Use the explorer agent to find where auth is implemented.`

### 4. Inspect agent definitions

- `/agents` — list discovered agents
- `/agents <name>` — show full details for one agent

## 📄 License

[MIT](LICENSE)
