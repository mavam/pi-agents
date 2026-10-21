# Agent profiles

A profile bundles reusable settings for agents. Create `.pi/agents/planner.md`:

```md
---
name: planner
description: Maps a codebase and proposes implementation plans
model: claude-opus-4-5
thinking: high
tools: [read, grep, find, ls]
skills: [architecture]
---

Map the relevant code and return a concrete implementation plan with file
paths. Do not edit files.
```

Then ask for it:

```text
Have a planner agent plan the caching layer.
```

Profile fields:

| Field | Meaning |
| --- | --- |
| `name` | Profile name. Required. |
| `description` | When to use the profile. Required. |
| `model` | Model as `provider/id` or `id`. Defaults to the session's model. |
| `thinking` | Thinking level. Defaults to the session's level. |
| `tools` | Tool allowlist. Defaults to the session's active tools that agents can run, or `read`, `bash`, `edit`, `write` if it has none. |
| `skills` | Skills to apply in full, including those only you can invoke. Without this field, the agent sees your skill catalog. An empty list disables skills. |
| `spawn` | Whether agents of this profile may spawn agents of their own. Defaults to `false`. |

The Markdown body extends the agent's system prompt. Arguments that Pi passes
to `agent_spawn` override profile settings.

Pi-agents reads profiles from `~/.pi/agent/agents` and, for trusted
projects, `.pi/agents` in the directory where you started Pi. Project
profiles override user profiles with the same name.
