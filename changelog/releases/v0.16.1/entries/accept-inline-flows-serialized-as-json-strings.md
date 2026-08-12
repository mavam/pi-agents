---
title: Accept inline flows serialized as JSON strings
type: bugfix
authors:
  - mavam
created: 2026-08-12T10:02:31.985943Z
---

The `workflow_create` tool now accepts an inline `flow` that arrives as a JSON string. Some tool-calling harnesses serialize loosely-typed parameters as JSON text instead of structured objects, which previously failed with `invalid flow: at $: expected a flow node object, got string`. Stringified flows are now parsed before validation, and a string that is not valid JSON produces a clear error.
