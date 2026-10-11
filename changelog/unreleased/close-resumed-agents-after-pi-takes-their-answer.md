---
title: Close resumed agents after Pi takes their answer
type: bugfix
authors:
  - mavam
created: 2026-10-11T17:52:50.563365Z
---

If you interrupt an agent and resume it by chatting in the attach view, Pi's wait now closes it once it takes the new answer. The finished agent no longer stays idle in the panel indefinitely. Failed and interrupted agents still stay open, and saved conversations remain available.
