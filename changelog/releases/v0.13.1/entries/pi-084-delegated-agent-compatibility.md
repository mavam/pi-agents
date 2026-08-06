---
title: Pi 0.84 delegated agent compatibility
type: bugfix
authors:
  - mavam
  - codex
prs:
  - 51
created: 2026-08-06T13:17:51.827239Z
---

Delegated workflows remain observable and recover cleanly with Pi 0.84. Live agent output continues updating while responses stream, partial text is preserved when a delegated process exits early, and transient model-catalog refresh failures can retry on later events.
