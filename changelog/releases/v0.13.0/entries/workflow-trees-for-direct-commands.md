---
title: Rooted workflow trees for saved workflows
type: bugfix
authors:
  - mavam
  - codex
prs:
  - 44
  - 47
created: 2026-08-04T18:13:34.332064Z
---

Saved-workflow commands now show the same parameters and flow-tree preview as
model-triggered runs. Named workflows render their steps beneath the workflow
title across start previews and workflow details:

```
❖ review
│  target: .
├─ ✦ reviewer · Review the target
└─ ✦ worker · Apply the findings
```

For example, `/review .` now shows the workflow structure when the run starts
instead of showing only the run ID.
