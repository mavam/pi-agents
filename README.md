# 🤖 pi-agents

A generic framework for agent orchestration in
[pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent).

## 📦 Install

```bash
pi install npm:pi-agents
```

Agents are loaded from:

- **User agents:** `~/.pi/agents/*.md`
- **Project agents:** the nearest `.pi/agents/*.md`, searched upward from your
  current working directory

The tools default to **both** project and user agents.

## 🚀 Quick start

### 1. Create an agent file

For example, create `.pi/agents/explorer.md` in your project:

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

### 2. Start pi

```sh
pi
```

This repo already includes project-local examples in `.pi/agents/`
(`explorer`, `worker`).

### 3. Delegate a single agent

Ask naturally:

- `Use the explorer agent to find where auth is implemented.`

You can also call the `agent` tool directly:

```json
{
  "name": "explorer",
  "task": "Find where auth is implemented.",
  "scope": "both"
}
```

### 4. Run a workflow

You can run explicit, JSON-defined agent workflows with the `workflow` tool.

Supported flow nodes:

- `spawn`
- `sequence`
- `fork`
- `join`
- `loop`

Example review loop:

```json
{
  "label": "review loop",
  "flow": {
    "kind": "loop",
    "id": "review-loop",
    "maxIterations": 3,
    "continueWhen": {
      "kind": "result_field",
      "path": "done",
      "equals": false
    },
    "body": {
      "kind": "sequence",
      "steps": [
        {
          "kind": "spawn",
          "id": "review",
          "agent": "reviewer",
          "task": "Review the current patch. Return JSON with done:boolean, findings:string[], and summary:string.",
          "output": "json"
        },
        {
          "kind": "spawn",
          "id": "implement",
          "agent": "engineer",
          "task": "Implement the latest review findings.",
          "output": "text"
        }
      ]
    }
  },
  "budgets": {
    "maxIterations": 3,
    "maxParallelism": 2
  }
}
```

The runtime is subprocess-backed in v1 and persists run lifecycle events in
the session so pi can reconstruct run state after reload.

## 🔧 Available tools

### `agent`

Runs one isolated delegated agent.

Parameters:

- `name`: Agent name from markdown frontmatter.
- `task`: The delegated task.
- `scope`: Optional. One of `user`, `project`, or `both`.
- `cwd`: Optional working directory for the delegated process.

### `workflow`

Runs an explicit workflow graph over delegated agent runs.

Top-level parameters:

- `label`: Optional workflow label.
- `flow`: A JSON-defined `FlowSpec`.
- `budgets`: Optional runtime limits.
- `scope`: Optional default agent scope.
- `cwd`: Optional default working directory.

Budget fields:

- `maxDepth`
- `maxChildren`
- `maxParallelism`
- `maxIterations`

## 🧭 Commands

| Command               | Description                                |
| --------------------- | ------------------------------------------ |
| `/agents`             | List discovered agents.                    |
| `/agent <name>`       | Show full details for one agent.           |
| `/runs`               | List runs recorded in the current session. |
| `/run <id-or-prefix>` | Show details for one run.                  |

## 🗂️ Flow spec reference

### `spawn`

```json
{
  "kind": "spawn",
  "id": "review",
  "agent": "reviewer",
  "task": "Review the current patch.",
  "scope": "both",
  "cwd": "/path/to/project",
  "output": "json"
}
```

### `sequence`

```json
{
  "kind": "sequence",
  "steps": [
    { "kind": "spawn", "agent": "reviewer", "task": "Review." },
    { "kind": "spawn", "agent": "engineer", "task": "Implement." }
  ]
}
```

### `fork`

```json
{
  "kind": "fork",
  "id": "fanout",
  "branches": {
    "a": { "kind": "spawn", "agent": "reviewer", "task": "Review for bugs." },
    "b": { "kind": "spawn", "agent": "reviewer", "task": "Review for style." }
  },
  "concurrency": 2
}
```

### `join`

```json
{
  "kind": "join",
  "from": "fanout",
  "mode": "all",
  "reducer": { "kind": "collect" },
  "onFailure": "collectErrors"
}
```

`mode` can be `all`, `any`, or `quorum`.

### `loop`

```json
{
  "kind": "loop",
  "id": "review-loop",
  "body": { "kind": "spawn", "agent": "reviewer", "task": "Review." },
  "maxIterations": 3,
  "continueWhen": {
    "kind": "result_field",
    "path": "done",
    "equals": false
  }
}
```

`continueWhen` currently supports checking a single field in the latest result.

## 📄 License

[MIT](LICENSE)
