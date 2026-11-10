Agents now benefit from fixes for stalled parallel tool calls and MCP schema handling, and honor your Pi transport, WebSocket connection timeout, and thinking-budget settings. Update Pi to 1.5.1 or later before updating pi-agents.

## 💥 Breaking changes

### Pi 1.5.1 required

pi-agents now requires Pi 1.5.1 or later, so update Pi before updating pi-agents. The update brings fixes to the runtime agents run on:

- Agents no longer get stuck after parallel tool calls. A tool call that ended at an unlucky moment could leave its agent working or waiting forever.
- `tool_search` finds MCP tools by the properties and descriptions their input schemas define under `$defs`.
- One MCP tool whose schema contains a malformed `$ref`, such as `#/$defs/%E0`, no longer makes every `codemode` script fail with `URI malformed`.

*By @mavam in #122.*

## 🐞 Bug fixes

### Agents follow Pi's transport and thinking budget settings

Agents now follow more of your Pi settings for model requests: `transport`, for example `"websocket"`, `websocketConnectTimeoutMs`, and `thinkingBudgets`. Previously, agents used the provider defaults regardless of these settings.

*By @mavam in #122.*
