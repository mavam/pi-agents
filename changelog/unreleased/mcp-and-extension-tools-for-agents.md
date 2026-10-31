---
title: MCP and extension tools for agents
type: feature
authors:
  - mavam
created: 2026-10-31T11:33:03.666267Z
---

Agents can now use your MCP servers and the tools of extensions you share with them, such as Webfox's web search. Every agent gets the tools of the servers in your `mcp.json`, with your sign-ins, and calls them from `codemode` scripts as Pi does. To share an extension's tools, list its package:

```json
{
  "piAgents": {
    "twinExtensions": ["npm:webfox"]
  }
}
```

pi-agents runs these tools in a tool twin, a headless Pi session next to yours that loads only Pi's MCP support and the listed packages. A call to an external system isn't repeated after a crash unless its author marks it as read-only or idempotent.
