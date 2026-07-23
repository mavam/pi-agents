---
title: Publish live run events for other extensions
type: feature
authors:
  - mavam
  - codex
created: 2026-07-23T00:00:00Z
---

Co-loaded pi extensions can now observe every live workflow lifecycle event on
the `pi-agents:run-event` event-bus channel. The versioned envelope carries the
existing event-sourced `RunEvent` vocabulary, including expanded flows, node
progress, backgrounding, final values, usage, and failures. Published events
are detached snapshots, so a subscriber cannot accidentally mutate pi-agents'
internal run state. A matching `pi-agents:ready` signal announces the protocol
and package version at session start.
