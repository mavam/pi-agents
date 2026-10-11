---
title: Yield panel keys to the question picker
type: bugfix
authors:
  - wyattjoh
created: 2026-10-11T00:25:52Z
---

The agent panel no longer intercepts left arrow or other navigation keys while the `rpiv-ask-user-question` picker is open. Opening the picker releases panel focus and suspends Ctrl+Q as well. Normal panel navigation resumes when the picker closes.
