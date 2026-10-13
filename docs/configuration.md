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

## Working agents

Agents work in parallel, and each sends its own model requests. A model
server that serves one conversation at a time, such as a local LLM with one
prompt cache, has to reprocess an agent's whole context whenever another
agent's request comes in between. Cap how many agents work at once in
`~/.pi/agent/settings.json` or your project's `.pi/settings.json`:

```json
{
  "piAgents": {
    "maxWorkingAgents": 1
  }
}
```

An agent takes a slot at its first model request and keeps it, tool calls
included, until its work ends, so its requests follow each other. Agents over
the cap wait their turn in order and show as working meanwhile. An agent that
waits for its helpers gives its slot to them until they finish. A message
that arrives after an agent finished waits for a slot again.

Agents, graphs, and helpers share the cap. Your session's own requests don't
count toward it. Without the setting, agents aren't capped. Restart Pi after
changing it.

## Storage retention

Pi-agents keeps each session's agents in its own store in
`~/.pi/agent/pi-agents/sessions/<session-id>/`, apart from Pi's session
file, and keeps it after Pi deletes that file. To delete stores you no longer
use, set how many days to keep them in `~/.pi/agent/settings.json` or your
project's `.pi/settings.json`:

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

With [pi-fancy-footer](https://github.com/mavam/pi-fancy-footer) installed,
pi-agents can show open agents by state, such as `✦ 2◉ 1●`. Enable the
`agents` widget through `/fancy-footer`.
