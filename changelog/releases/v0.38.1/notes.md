Pi-agents now adds its guidance as a Pi prompt section instead of replacing the system prompt. This keeps provider prompt caches valid when agent guidance changes mid-session.

## 🐞 Bug fixes

### Agent guidance keeps the prompt cache

The agent guidance in Pi's system prompt is now a prompt section instead of a replaced system prompt. Before, a change to any other part of the prompt during a session, such as MCP servers that finish connecting, changed the leading system prompt and made the provider write the whole conversation to its prompt cache again. Now Pi adds only a small update, and the cached conversation stays valid.

*By @Haichiu in #118.*
