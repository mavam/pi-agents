---
title: Queued message restoration on agent interrupts
type: bugfix
authors:
  - mavam
created: 2026-08-25T16:33:31.983362Z
---

Pressing `Esc` while attached to a delegated agent now returns queued messages to the attached editor before interrupting the turn. The messages keep their original order and appear ahead of any draft already in the editor, matching Pi's main editor.
