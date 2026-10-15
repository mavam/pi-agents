---
title: Show closed agents in the footer count
type: change
authors:
  - mavam
created: 2026-10-15T07:09:33.868309Z
---

The pi-fancy-footer `agents` widget now counts closed agents with a new `◌`
glyph, such as `2◉ 1● 3◌`. A closed agent is one whose answer reached Pi or
that was stopped, and messaging it starts it again. The widget also drops its
`✦` prefix, colors each glyph by its status, and now sits left of the model
instead of at the right edge.

Closed agents and graphs show `◌` in `/agents`, in `/agent` completions,
and in the attach view. An agent or graph whose result waits for Pi shows `◐`
instead of an accent-colored `●`, and a failed one shows `⊗` instead of `✗`,
so every status has its own circle glyph. Graph
details and tool results still show how each agent's work ended. Closed
helpers don't count in the footer, because nobody can message them.
