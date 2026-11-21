---
title: Forward prompt snippets and guidelines from shared extension tools
type: bugfix
authors:
  - mavam
created: 2026-11-21T06:11:42.382816Z
---

Shared extension tools hosted by the tool twin now contribute their `promptSnippet` and `promptGuidelines` to agents' `<tools>` and `<rules>` system prompt sections whenever those tools are declared to the model, matching Pi. Deferred tools stay out of `<tools>` and `<rules>` unless loaded with `tool_search`. Previously, prompt snippets and guidelines from shared extension tools were dropped from subagents' system prompts.
