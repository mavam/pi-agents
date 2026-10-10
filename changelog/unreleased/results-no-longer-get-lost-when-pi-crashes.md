---
title: Results no longer get lost when Pi crashes
type: bugfix
authors:
  - mavam
prs:
  - 80
created: 2026-10-10T10:18:49.037547Z
---

A crash or a killed Pi process no longer loses an agent's result. Before, pi-agents considered a result delivered as soon as it handed the message to Pi, so if Pi went down before it saved the message, the result never arrived. Now a result counts as delivered only once your session contains it, as a message or in the answer of a call that waited for it. When you resume the session, results it already contains don't post again, and results it doesn't contain post again.
