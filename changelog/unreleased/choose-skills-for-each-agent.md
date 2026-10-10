---
title: Choose skills for each agent
type: feature
authors:
  - mavam
prs:
  - 79
created: 2026-10-10T08:01:23.60034Z
---

Pi can now name the skills an agent gets, so you can ask for an agent that
works with particular skills:

```text
Have an agent update the changelog with the tenzir-ship skill.
```

The agent gets those skills in full instead of the whole skill catalog, and an
empty list gives it none. The skills of a profile work the same way, and named
skills replace them. Agents that delegate can name skills for their helpers.

Skills marked `disable-model-invocation: true` stay yours to invoke: Pi and
agents can't name them. To give agents such a skill, name it in a profile:

```md
---
name: reviewer
description: Reviews changes with the code-review skill
skills: [code-review]
---
```
