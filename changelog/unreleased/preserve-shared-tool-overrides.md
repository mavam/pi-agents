---
title: Shared extension overrides of built-in tools
type: bugfix
authors:
  - sunnysab
prs:
  - 134
created: 2026-11-26T03:23:27Z
---

Shared extensions listed in `piAgents.twinExtensions` that override built-in tool names (such as `pi-hashline-edit-pro`'s `read` and `grep`) are no longer stripped from agents. Overridden tools now follow the agent's built-in tool allowlist—including when agents spawn helpers—while keeping the shared implementation, its prompt guidance, and ambient skill discovery.
