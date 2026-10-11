---
title: Prune old agent storage with piAgents.retentionDays
type: feature
authors:
  - mavam
created: 2026-10-11T17:33:03.22198Z
---

Pi-agents can now delete the agent storage of sessions you no longer use. Set `piAgents.retentionDays` in `~/.pi/agent/settings.json` or the project's `.pi/settings.json`, and at each Pi start pi-agents removes the stores in `~/.pi/agent/pi-agents/sessions/` that haven't changed for that many days. The current session's store and stores another running Pi holds stay. Without the setting, nothing is deleted.
