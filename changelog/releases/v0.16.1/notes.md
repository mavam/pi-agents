Pi Agents now accepts inline workflow flows delivered as JSON strings, improving compatibility with tool-calling harnesses that serialize loosely typed parameters. Invalid strings produce clear errors instead of opaque validation failures.

## 🐞 Bug fixes

### Accept inline flows serialized as JSON strings

The `workflow_create` tool now accepts an inline `flow` that arrives as a JSON string. Some tool-calling harnesses serialize loosely-typed parameters as JSON text instead of structured objects, which previously failed with `invalid flow: at $: expected a flow node object, got string`. Stringified flows are now parsed before validation, and a string that is not valid JSON produces a clear error.

*By @mavam.*
