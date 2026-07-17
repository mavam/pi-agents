---
name: bug-hunt
description: Hunt correctness bugs in a target
trigger: when the user wants a focused bug pass without a full multi-lens review
params:
  - name: target
    description: What to hunt in (a path, diff, or description)
    required: true
agent: reviewer
task: "Review {params.target} strictly for correctness bugs: logic errors, edge cases, races, resource leaks. Return findings with file paths, ranked by severity."
thinking: high
---

A single-unit workflow: one reviewer pass, no graph. Referenceable from other
workflows as `{ kind: workflow, name: bug-hunt, params: { target: "…" } }`.
