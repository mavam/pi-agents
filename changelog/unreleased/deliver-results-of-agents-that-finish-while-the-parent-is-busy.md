---
title: Deliver results of agents that finish while the parent is busy
type: bugfix
authors:
  - mavam
prs:
  - 80
created: 2026-10-10T12:38:07.953177Z
---

Results of agents that finish while Pi is working on a turn now reach the conversation once Pi is done. Before, such a result could stay "result queued" in the panel and never arrive, until something else happened while Pi was idle, such as another agent finishing, closing the attach view, or Pi waiting for agents. This happened more often alongside other extensions that do work when a turn ends. A result that waits for Pi to finish a compaction, for messages you queued, or for a tree navigation now arrives as well.
