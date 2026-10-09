This release lets you cap how many model requests your agents send at once, so they work well with model servers that serve one request at a time, such as local LLMs.

## 🚀 Features

### Limit concurrent model requests of agents

Cap how many model requests your agents send at once with `piAgents.maxConcurrentRequests` in `~/.pi/agent/settings.json` or your project's `.pi/settings.json`. This helps with model servers that handle one request at a time, such as local LLMs:

```json
{
  "piAgents": {
    "maxConcurrentRequests": 1
  }
}
```

Requests over the cap wait their turn in order instead of failing, and agents keep running tools in the meantime. Agents, graphs, and helpers all share the cap. Without the setting, requests aren't limited.

*By @mavam in #75.*
