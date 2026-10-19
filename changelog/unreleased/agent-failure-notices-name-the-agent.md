---
title: Agent failure notices name the agent
type: change
authors:
  - mavam
prs:
  - 108
created: 2026-10-19T08:00:13.527245Z
---

Notices about failures in agents' background work now name the agent or graph they are about and say what failed, such as `Agent api: its tool call failed: …`, instead of showing only the error. When an agent's work stalls after repeated crashes, the notice says how to retry or stop it. A storage failure now shows one notice instead of two.
