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

## 📖 Concepts

### Agent

An **agent** is a markdown file that defines a delegated pi subprocess. Each
file has YAML frontmatter (name, model, thinking level, skills) and a body that
becomes the agent's system prompt. At runtime the framework launches the agent
as an isolated pi process, waits for it to finish, and returns the result.

### Workflow

A **workflow** is a JSON-defined graph that orchestrates multiple agents. You
pass the graph to the `workflow` tool, and the runtime walks it node by node.

### Flow spec

The JSON structure that describes a workflow graph is called a **flow spec**.
A flow spec is a tree of **nodes**, where each node has a `kind` that
determines its behavior:

| Node       | Purpose                                                         |
| ---------- | --------------------------------------------------------------- |
| `spawn`    | Run a single agent as a subprocess and return its output.       |
| `sequence` | Run a list of nodes one after another, threading results.       |
| `fork`     | Run named branches concurrently (up to a concurrency limit).    |
| `join`     | Wait for the branches of a previous `fork` and combine results. |
| `loop`     | Repeat a body node until a condition is met or a cap is hit.    |

Nodes nest recursively: a `sequence` can contain `fork` nodes, a `loop`
body can be a `sequence`, and so on.

### Budgets

**Budgets** are optional limits that constrain a workflow execution:

| Budget           | What it limits                                            |
| ---------------- | --------------------------------------------------------- |
| `maxDepth`       | Maximum nesting depth of the flow-spec tree.              |
| `maxChildren`    | Maximum number of child nodes a single node may produce.  |
| `maxParallelism` | Maximum concurrent subprocess agents across the workflow. |
| `maxIterations`  | Maximum iterations for any single `loop` node.            |

### Runs

Every agent delegation and workflow execution is persisted as a **run** in the
current pi session. Runs survive session reloads so you can inspect past
results. The `/runs` and `/run` commands let you list and drill into them.

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

Use the `workflow` tool to run a multi-agent flow spec. The example below
defines a review loop: a `reviewer` agent inspects the patch, then an
`engineer` agent applies the findings, repeating until the reviewer signals
`done` or three iterations have passed.

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

The runtime launches each `spawn` as a subprocess and persists lifecycle events
into the session so pi can reconstruct state after a reload.

## 🔧 Available tools

### `agent`

Runs one isolated delegated agent as a subprocess.

Parameters:

- `name`: Agent name from markdown frontmatter.
- `task`: The delegated task.
- `scope`: Optional. One of `user`, `project`, or `both`.
- `cwd`: Optional working directory for the delegated process.

### `workflow`

Runs a workflow defined by a flow spec.

Top-level parameters:

- `label`: Optional human-readable label for this workflow run.
- `flow`: The flow spec (a JSON tree of nodes).
- `budgets`: Optional budget limits (see [Budgets](#budgets)).
- `scope`: Optional default agent scope for all `spawn` nodes.
- `cwd`: Optional default working directory for all `spawn` nodes.

## 🧭 Commands

| Command               | Description                                |
| --------------------- | ------------------------------------------ |
| `/agents`             | List discovered agents.                    |
| `/agent <name>`       | Show full details for one agent.           |
| `/runs`               | List runs recorded in the current session. |
| `/run <id-or-prefix>` | Show details for one run.                  |

## 🗂️ Flow spec reference

### `spawn`

Run a single agent as a subprocess. This is the leaf node of every flow spec—
the only node kind that actually executes work.

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

- `id`: Optional identifier, used to reference this node's result elsewhere.
- `agent`: Name of the agent (must match a discovered agent's frontmatter).
- `task`: The task prompt sent to the agent.
- `output`: `"text"` (default) or `"json"` (the agent's output is parsed as
  JSON, useful for downstream `continueWhen` checks).

### `sequence`

Run a list of nodes one after another. The output of the sequence is the output
of its last step.

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

Run named branches concurrently. Each branch is an arbitrary flow spec. Use
`concurrency` to cap how many branches run in parallel.

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

- `id`: Required. Referenced by a downstream `join` node.
- `branches`: A map of branch keys to flow specs.
- `concurrency`: Optional cap on simultaneous branches.

### `join`

Wait for the branches of a previous `fork` and combine their results.

```json
{
  "kind": "join",
  "from": "fanout",
  "mode": "all",
  "reducer": { "kind": "collect" },
  "onFailure": "collectErrors"
}
```

- `from`: The `id` of the `fork` node to join.
- `mode`: When to proceed—`"all"` (every branch must finish), `"any"` (first
  success wins), or `"quorum"` (a minimum number of successes, set by the
  `quorum` field).
- `reducer`: How to combine branch results. `"collect"` gathers them into an
  object keyed by branch name. `"agent"` delegates summarization to another
  agent.
- `onFailure`: `"failFast"` (default, abort on first branch error) or
  `"collectErrors"` (continue and gather errors alongside successes).

### `loop`

Repeat a body node until a condition is met or `maxIterations` is reached.

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

- `id`: Required.
- `body`: Any flow spec to execute each iteration.
- `maxIterations`: Hard cap on repetitions.
- `continueWhen`: Optional predicate evaluated after each iteration. Currently
  supports `result_field`, which checks a single field in the body's JSON
  output. The loop continues while the field matches `equals` and stops
  otherwise.

## 📄 License

[MIT](LICENSE)
