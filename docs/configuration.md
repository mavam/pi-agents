# ⚙️ Configuration

Configure the models agents use, share extension tools with them, cap how
many agents work at once, and show agent counts in the footer.

## Models

An agent runs on your session's model unless Pi or a profile picks another.
Models resolve like `pi --model`: `sonnet` picks the newest Sonnet you have
credentials for, and an exact ID such as `claude-sonnet-4-6` picks that
version. Run `pi --list-models` to see what's available.

Pi learns which names are models from your scoped models, the ones you pick
with `/scoped-models` or `--models`. Scope the models you want agents to use,
and Pi picks them by name: "spawn a Luna agent" runs on your scoped Luna.

## Settings from other extensions

Extensions must opt into [agent hooks](./hooks.md); parent request hooks
aren't inherited automatically. For example, a compatible pi-service-tier
version can pass its service tiers and `/fast` overrides to agents.
Captured settings survive resumes and pass to the agents that agents
spawn. Later parent changes affect future agents only.

## Extension tools

Agents get the tools of your MCP servers and of the extensions you list
under `piAgents.twinExtensions`, as package sources like those in Pi's
`packages` setting. For example, to give agents Webfox's web tools:

```json
{
  "piAgents": {
    "twinExtensions": ["npm:webfox"]
  }
}
```

Agents reach these tools through a tool twin: a second, headless Pi session
that pi-agents runs alongside yours, since Pi runs these tools only in a Pi
session and offers no way to call yours from the background
([why](./design.md#tools-from-pi)). It loads only Pi's MCP support and the
listed packages, which must be installed in Pi, and uses your `mcp.json`
files and MCP sign-ins. As in Pi, a project's `.pi/mcp.json`, its
`piAgents` settings, and packages installed in it count only when you trust
the project. The twin starts in the background, so agents never wait for
it to open. In a session that used it before, agents get its tools at once,
and a call waits until its server connected, up to ten seconds after the
twin started. Otherwise, starting the first agents waits up to ten seconds
for your MCP servers to connect. Servers that take longer reach agents once
they do. List only extensions whose tools work on their own: the twin has no
UI, and its tools see an empty conversation rather than yours. Restart Pi
after changing the list, `mcp.json`, or your MCP sign-ins.

## Working agents

Cap parallel work to reduce contention, for example on a local model
server. Set the limit in `~/.pi/agent/settings.json` or, in a trusted
project, its `.pi/settings.json`:

```json
{
  "piAgents": {
    "maxWorkingAgents": 1
  }
}
```

An agent keeps its slot until its work ends, including tool calls, but
yields it while a direct `agent_wait` call waits for the agents it spawned.
Agents over the cap wait in order and show as working. A later message to a
finished agent waits for a new slot.

Agents in every group, including spawned agents, share the cap. Your
session's own requests don't count toward it. Without the setting, no additional
working-agent cap applies. Restart Pi after changing it.

This concurrency setting is separate from the fixed spawning limits:
12 agents per group, 24 children per spawning agent over its lifetime, and
16 unfinished initial spawned-agent jobs in a session (including agents
waiting on dependencies). Later messages to agents whose initial jobs
finished don't use that fixed 16-agent allowance, but still use the
working-agent cap. The lifetime limit includes completed and cancelled
children and never replenishes. See
[agents that spawn agents](./graphs.md#agents-that-spawn-agents).

## Pi settings agents follow

Agents follow your Pi settings for provider retries and timeouts, the
`transport` and `websocketConnectTimeoutMs` of model requests,
`thinkingBudgets`, retries after errors, compaction, and how steering and
follow-up messages queue.
They read them when the session first uses agents, so restart Pi after
changing them.

Compaction follows Pi's per-model token settings too: an agent on a model
listed in `compaction.modelOverrides` compacts with that entry's
`reserveTokens` and `keepRecentTokens`, keyed by the exact
`provider/modelId`. Pi's [settings reference](https://pi.dev/docs/latest/settings#per-model-compaction-overrides)
describes them.

Agents' model requests identify themselves to providers as Pi's do. While
Pi's install telemetry is on, which the `enableInstallTelemetry` setting or
the `PI_TELEMETRY` environment variable controls, requests to OpenRouter,
NVIDIA NIM, and OpenCode name Pi as the app that sent them; with it off,
they name no app.

## Storage retention

[Agent storage](./architecture.md#storage) remains after Pi deletes its
session file. To remove inactive stores, set a retention period in
`~/.pi/agent/settings.json` or, in a trusted project, its `.pi/settings.json`:

```json
{
  "piAgents": {
    "retentionDays": 30
  }
}
```

A store is old when neither it nor its agents' data changed for that many
days. When Pi starts, pi-agents deletes old stores in the background. It
keeps the current session's store and stores another running Pi holds, and
deleting one removes its agents for good. Without the setting, stores stay
forever. Changes apply the next time Pi starts.

## Footer counters

With [pi-fancy-footer](https://github.com/mavam/pi-fancy-footer), enable the
`agents` widget through `/fancy-footer` to show counts by state, such as
`2◉ 1● 3◌`. Counts include closed agents, but not closed spawned agents.
