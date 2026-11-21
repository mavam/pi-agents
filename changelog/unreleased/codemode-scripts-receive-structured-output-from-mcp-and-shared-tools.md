---
title: Codemode scripts receive structured output from MCP and shared tools
type: bugfix
authors:
  - mavam
created: 2026-11-21T05:41:21.539265Z
---

Tools that agents reach through the tool twin—such as MCP tools and shared Pi extensions—now forward their output schemas and structured results to `codemode` scripts. Scripts see each tool's declared return type in `describeTool()` and receive its full structured output (including MCP error results that carry one), rather than the truncated text summary meant for the model.
