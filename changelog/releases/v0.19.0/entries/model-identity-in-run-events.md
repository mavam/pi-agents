---
title: Model identity in run events
type: change
authors:
  - mavam
created: 2026-08-24T08:47:43.620037Z
---

Run events now report each agent node's planned model, authored model reference, thinking level, and effective model changes. Extensions subscribed through `pi-agents/api` can use `node_started` for planned identity and `node_model` for the latest model observed during a run. Existing protocol-v2 histories remain compatible because all new identity fields are optional.
