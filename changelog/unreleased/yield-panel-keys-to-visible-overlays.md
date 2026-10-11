---
title: Yield panel keys to visible overlays
type: bugfix
authors:
  - wyattjoh
created: 2026-10-11T00:25:52Z
---

The agent panel no longer intercepts left arrow or other navigation keys while any TUI overlay is visible. The panel releases focus and suspends Ctrl+Q as well, without relying on events from a specific extension. This also prevents opening `/agents` over an overlay when the panel is empty. Normal panel navigation resumes when the overlays close.
