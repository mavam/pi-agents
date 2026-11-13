---
title: Keep terminal status working while child agents run
type: bugfix
authors:
  - wyattjoh
created: 2026-11-13T02:56:03Z
---

Terminals that show Pi's status, such as Herdr, now keep showing Pi as working while child agents work or wait on their inputs, even after your own turn ends. Questions, permission prompts, and errors still take priority. Once no child is active, the terminal shows Pi's own status again.
