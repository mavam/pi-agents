---
title: Algebraic workflow rewrite
type: feature
authors:
  - mavam
created: 2026-07-16T00:00:00.000000Z
---

Workflows are now closed expression trees: every node — `agent`, `seq`,
`par`, `map`, `loop`, `workflow` — yields a value, `par` fuses fork and join
into one expression with an inline reducer, `map` fans out dynamically over
runtime arrays, and saved workflows inline like function calls with cycle
detection. Data flows only through explicit references (`as` bindings,
`{previous}`, `{item}`, `{params.*}`); unknown references fail validation
with node paths before anything spawns. The old spawn/sequence/fork/join
node tree, its implicit context injection, and v2 persisted flow events are
gone.
