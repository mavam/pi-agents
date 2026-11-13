---
title: Keep terminal status working while child agents run
type: bugfix
authors:
  - wyattjoh
created: 2026-11-13T02:56:03Z
---
Interactive terminal status now stays working while child agents run after the parent session settles. Native questions, permissions, errors, and status clearing retain priority. When the last child stops, or the session reloads or closes, the parent's latest status and native reporting are restored.
