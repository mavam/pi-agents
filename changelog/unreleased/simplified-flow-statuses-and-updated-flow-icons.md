---
title: Simplified flow statuses and updated flow icons
type: change
authors:
  - mavam
  - codex
created: 2026-03-18T07:26:14.89324Z
---

Flow inspection now uses a simpler public state model with four statuses: `waiting`, `running`, `completed`, and `stopped`. The previous `queued`, `failed`, and `aborted` labels are no longer shown in the flow UI, and `/flows`, `/flow`, and live workflow widgets now use one consistent icon palette.

Status overlays now render as:

- `○` waiting
- `◉` running
- `●` completed
- `⊘` stopped

Flow structure icons were also refreshed to make the control-flow tree easier to scan:

- `✦` spawn
- `⑃` fork
- `⑂` join
- `↺` loop
- `≡` sequence

This makes workflow trees easier to read at a glance and reduces ambiguity between transient and terminal states when monitoring long-running flows.
