---
title: Agent requests follow Pi's telemetry setting
type: bugfix
authors:
  - mavam
prs:
  - 108
created: 2026-10-22T05:23:27.016642Z
---

Agents' model requests now identify themselves to providers as Pi's own requests do: they send Pi's `User-Agent`, and name Pi as the app to OpenRouter, NVIDIA NIM, and OpenCode only while Pi's install telemetry is on. Turning telemetry off with the `enableInstallTelemetry` setting or `PI_TELEMETRY=0` now covers agents too.
