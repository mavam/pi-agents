---
title: Detach from an agent with Ctrl+D
type: feature
authors:
  - mavam
prs:
  - 84
created: 2026-10-10T19:29:31.845739Z
---

Ctrl+D now leaves the agent you're attached to, like ← does, instead of quitting Pi. As in Pi's editor, it only does so while the editor is empty. Esc leaves an idle agent too, also only while the editor is empty, and still interrupts a working one. Tab now cycles the panel, `/agents`, and `/messages`, and Shift+Tab goes back.
