# ⚙️ Configuration

Configure the models agents use, limit concurrent requests, and show agent
counts in the footer.

## Models

An agent runs on your session's model unless Pi or a profile picks another.
Models resolve like `pi --model`: `sonnet` picks the newest Sonnet you have
credentials for, and an exact ID such as `claude-sonnet-4-6` picks that
version. Run `pi --list-models` to see what's available.

Pi learns which names are models from your scoped models, the ones you pick
with `/scoped-models` or `--models`. Scope the models you want agents to use,
and Pi picks them by name: "spawn a Luna agent" runs on your scoped Luna.

## Concurrent requests

Agents work in parallel and each sends its own model requests. A model
server that handles one request at a time, such as a local LLM, can fall
behind or time out. Cap how many requests agents send at once in
`~/.pi/agent/settings.json` or your project's `.pi/settings.json`:

```json
{
  "piAgents": {
    "maxConcurrentRequests": 1
  }
}
```

Requests over the cap wait their turn in order, and agents keep working on
tools in the meantime. Agents, graphs, and helpers all share the cap. Your
session's own requests don't count toward it. Without the setting, requests
aren't limited. Restart Pi after changing it.

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
