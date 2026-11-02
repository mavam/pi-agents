Agents can now use your MCP servers and the extension tools you share with them, and you can continue agents that crashes or errors stopped. This release requires Pi 1.5.0 or later and adds turn limits for profiles, an attach view with the whole conversation, and failure reasons that survive restarts.

## 💥 Breaking changes

### Pi 1.5.0 required

pi-agents now requires Pi 1.5.0 or later, so update Pi before updating pi-agents. Sessions keep their agents across the update. Work that stalled after repeated crashes ends when its session opens: its agent fails, and so does a graph waiting for it. Press `r` in `/agents` to continue the agent. Going back to an earlier pi-agents version afterwards isn't supported: it can't read the state of agents this version ran, and shows their unfinished work as stalled.

*By @mavam in #119.*

## 🚀 Features

### MCP and extension tools for agents

Agents can now use your MCP servers and the tools of extensions you share with them, such as Webfox's web search. Every agent gets the tools of the servers in your `mcp.json`, with your sign-ins. As in Pi, agents with `codemode` call them from scripts, and agents without it load the ones they need with `tool_search`. To share an extension's tools, list its package:

```json
{
  "piAgents": {
    "twinExtensions": ["npm:webfox"]
  }
}
```

pi-agents runs these tools in a tool twin, a headless Pi session next to yours that loads only Pi's MCP support and the listed packages. As in Pi, an untrusted project's `mcp.json` and settings don't count. Agents started before the update keep the tools they had. A call to an external system isn't repeated after a crash unless its author marks it as read-only or idempotent.

*By @mavam.*

### Turn limits for agent profiles

Profiles can now limit how many tool rounds one run of an agent takes:

```md
---
name: scout
description: Maps a codebase quickly
maxTurns: 20
---
```

The round that reaches the limit still runs its tools, then the agent fails with `reached its turn limit`. Press `r` in `/agents` to continue it for another run.

Only profiles set the limit; `agent_spawn` has no argument for it. A turn limit is your budget for an agent, so the model that spawns agents can't loosen or skip it. It can pick a profile that has one, and it sees when an agent reached its limit, but only you can continue that agent.

*By @mavam.*

## 🔧 Changes

### Attach view shows the whole conversation

The attach view now shows an agent's whole conversation, with compactions and new contexts as markers where they happened, like Pi's own transcript. It opens with the newest entries and loads earlier ones as you scroll to the top, so attaching stays fast however long an agent worked.

*By @mavam.*

### Continue agents that crashes or errors stopped

Work that crashes Pi over and over no longer stalls its agent until you retry it. Pi now ends the work instead: a tool call fails with an error the agent sees, and a turn fails the agent with a notice that names it. A model request that a crash interrupted counts as a failed attempt and retries under Pi's retry settings; with no retry left, the agent fails the same way.

The agent's job and Pi's message stay open, and the agents it spawned keep working; their results wait until you continue it, so they don't restart work that crashes Pi. Select the agent in `/agents` and press `r` to continue it where it stopped. `r` continues any agent whose last turn ended without an answer, after a provider error or an interrupt too.

*By @mavam.*

## 🐞 Bug fixes

### Failure reasons survive restarts

An agent whose last turn ended without an answer now shows why after you restart Pi, for example a missing model, instead of only that it failed. `agent_status`, `/agents`, and the attach view show the same reason.

*By @mavam.*

### Untrusted projects no longer configure agents

pi-agents now ignores the `piAgents` settings of a project you haven't trusted, as Pi ignores its other settings. Before, an untrusted project's `.pi/settings.json` could cap working agents, change how agents retry and compact, or set how long agent storage is kept.

*By @mavam in #121.*
