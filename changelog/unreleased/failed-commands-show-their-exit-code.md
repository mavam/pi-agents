---
title: Failed commands show their exit code
type: bugfix
authors:
  - mavam
prs:
  - 91
created: 2026-10-13T06:36:24.609889Z
---

When you attach to an agent, a failed bash command now ends with "Command exited with code N", as in Pi, instead of a `<harness>` block meant for the model. Other tool notes, such as how read converted an image, show as plain lines too.
