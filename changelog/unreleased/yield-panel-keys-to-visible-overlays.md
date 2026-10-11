---
title: Yield panel keys to visible overlays
type: bugfix
authors:
  - wyattjoh
created: 2026-10-11T00:25:52Z
---

The agent panel no longer intercepts arrow keys or Ctrl+Q while another extension's overlay is visible. This also applies when the panel is empty, so it no longer opens `/agents` over an overlay. The panel conservatively yields to any visible overlay, even purely decorative ones. The panel's widget is now mounted from session start, so it may appear above other extensions' widgets where it previously appeared below them.
