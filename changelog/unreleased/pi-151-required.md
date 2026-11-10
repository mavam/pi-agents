---
title: Pi 1.5.1 required
type: breaking
authors:
  - mavam
created: 2026-11-10T08:23:05.029867Z
---

pi-agents now requires Pi 1.5.1 or later, so update Pi before updating pi-agents. The update brings fixes to the runtime agents run on:

- Agents no longer get stuck after parallel tool calls. A tool call that ended at an unlucky moment could leave its agent working or waiting forever.
- `tool_search` finds MCP tools by the properties and descriptions their input schemas define under `$defs`.
- One MCP tool whose schema contains a malformed `$ref`, such as `#/$defs/%E0`, no longer makes every `codemode` script fail with `URI malformed`.
