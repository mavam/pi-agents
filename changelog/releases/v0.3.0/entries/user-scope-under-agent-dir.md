---
title: User scope moves under ~/.pi/agent
type: bugfix
authors:
  - mavam
created: 2026-07-18T00:00:00.000000Z
---

User-scope agents and workflows now live inside pi's agent directory —
`~/.pi/agent/agents` and `~/.pi/agent/workflows` — matching pi's own
conventions for skills, prompts, and tools instead of the previous
`~/.pi/agents`/`~/.pi/workflows` siblings. This also makes the
`PI_CODING_AGENT_DIR` override apply to pi-agents resources wholesale, and
fixes the project-skills exclusion check to compare against pi's actual
user-skills location (`~/.pi/agent/skills`).
