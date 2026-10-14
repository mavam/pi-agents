---
title: Parent editor focus after pasting or typing
type: bugfix
authors:
  - mavam
prs:
  - 98
created: 2026-10-14T19:55:42.032769Z
---

Pasting or typing into the parent editor now releases the agent panel's keyboard control, including in terminals that encode text as key sequences. Previously, text could appear in the parent editor while the panel retained focus, so pressing Enter opened a child agent instead of sending the instructions.
