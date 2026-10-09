---
title: Stale answers after interrupted or failed follow-ups
type: bugfix
authors:
  - mavam
prs:
  - 77
created: 2026-10-09T11:10:31.00162Z
---

Waiting for an agent no longer reports its previous answer when its latest turn produced none. If you stopped an agent's follow-up before it wrote anything, Pi used to get the earlier answer as the result. A follow-up that failed without an error message used to report the earlier answer as the error. Waits now report only what the latest turn produced, and a failed turn says why it failed, such as `no_model`.
