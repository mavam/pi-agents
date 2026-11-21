Agents now open without waiting for every Model Context Protocol server to connect and instead wait lazily only for the servers a call actually reaches. Shared extension and server tools also forward their output schemas, structured results, prompt snippets, and guidelines to agents just as they do in Pi.

## 🔧 Changes

### Wait lazily for MCP servers instead of stalling agent startup

Opening agents no longer stalls up to ten seconds waiting for every configured MCP server to connect. Configured MCP namespaces now appear on an agent's first turn while servers connect in the background, tool calls wait lazily only for the connecting server they actually reach, and session recovery waits only for servers needed by unfinished MCP tool calls.

*By @mavam.*

## 🐞 Bug fixes

### Codemode scripts receive structured output from MCP and shared tools

Tools that agents reach through the tool twin—such as MCP tools and shared Pi extensions—now forward their output schemas and structured results to `codemode` scripts. Scripts see each tool's declared return type in `describeTool()` and receive its full structured output (including MCP error results that carry one), rather than the truncated text summary meant for the model.

*By @mavam.*

### Forward prompt snippets and guidelines from shared extension tools

Shared extension tools hosted by the tool twin now contribute their `promptSnippet` and `promptGuidelines` to agents' `<tools>` and `<rules>` system prompt sections whenever those tools are declared to the model, matching Pi. Deferred tools stay out of `<tools>` and `<rules>` unless loaded with `tool_search`. Previously, prompt snippets and guidelines from shared extension tools were dropped from subagents' system prompts.

*By @mavam.*
