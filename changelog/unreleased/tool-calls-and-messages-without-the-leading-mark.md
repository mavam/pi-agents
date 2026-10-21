---
title: Tool calls and messages without the leading mark
type: change
authors:
  - mavam
prs:
  - 114
created: 2026-10-21T07:53:12.087496Z
---

Agent tool calls and messages between agents now render without the leading `✦` mark. Tool calls show their name in bold, the way Pi shows its own tools:

```text
spawn lister profile=explorer thinking=low tools=[read,ls]
  List the files in src and summarize them.
```
