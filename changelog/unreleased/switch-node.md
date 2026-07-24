---
title: Data-driven routing with switch nodes
type: feature
authors:
  - mavam
  - claude
prs: []
created: 2026-07-24T20:24:02.542830Z
---

Workflows can now branch deterministically without burning an agent on the
decision. The new `switch` node names a JSON value with `on: "{binding}"`
(exactly like `map.over`), tries its `cases` predicates in definition order,
and runs the first matching arm — or the mandatory `else`. Exactly one arm
executes, and its value becomes the switch's value, so downstream references
never dangle:

```yaml
kind: switch
on: "{gate}"
cases:
  - when: { eq: ["status", "approved"] }
    then: { kind: agent, name: shipper, task: "Ship it" }
  - when: { exists: "findings" }
    then: { kind: agent, name: fixer, task: "Fix {gate.findings}" }
else: { kind: agent, name: reporter, task: "Report {gate.outcome}" }
```

Predicates are the same total language as `loop.until`. Flow trees render
the node as `⎇` with one line per arm, Mermaid diagrams draw a decision
diamond with labeled edges, and run inspection lights up only the arm that
ran.
