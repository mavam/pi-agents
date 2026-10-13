---
title: Publish child-agent lifecycle state
type: feature
authors:
  - wyattjoh
created: 2026-10-13T01:51:27Z
---

Co-loaded extensions can observe child-agent activity on `pi-agents:state`. Versioned, immutable snapshots publish after session restoration and whenever lifecycle state changes; `pi-agents:state:request` lets late listeners request the current state. Graceful shutdown clears live ownership without claiming persisted jobs completed. Terminal integrations can use these events to stay working while child agents run, even after the parent Pi session settles, without parsing the panel or footer.
