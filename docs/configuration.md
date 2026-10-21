# ⚙️ Configuration

Configure the models agents use, cap how many agents work at once, and show
agent counts in the footer.

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
Captured settings survive resumes and pass to helpers. Later parent
changes affect future agents only.

## Working agents

Cap parallel work to reduce contention, for example on a local model
server. Set the limit in `~/.pi/agent/settings.json` or your project's
`.pi/settings.json`:

```json
{
  "piAgents": {
    "maxWorkingAgents": 1
  }
}
```

An agent keeps its slot until its work ends, including tool calls, but
yields it while waiting for helpers. Agents over the cap wait in order and
show as working. A later message to a finished agent waits for a new slot.

Agents, graphs, and helpers share the cap. Your session's own requests don't
count toward it. Without the setting, agents aren't capped. Restart Pi after
changing it.

## Storage retention

[Agent storage](./architecture.md#storage) remains after Pi deletes its
session file. To remove inactive stores, set a retention period in
`~/.pi/agent/settings.json` or your project's `.pi/settings.json`:

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
`2◉ 1● 3◌`. Counts include closed agents, but not closed helpers.
