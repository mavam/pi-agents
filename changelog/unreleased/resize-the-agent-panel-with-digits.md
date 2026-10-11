---
title: Resize the agent panel with digits
type: feature
authors:
  - mavam
prs:
  - 84
created: 2026-10-11T12:59:39.634064Z
---

Press a digit in the focused panel to set how many rows it shows once you leave it. `1` turns the panel into a single summary line with the graph's name, how many agents are in each state, and how many messages wait; `0` hides it until another agent starts or you focus it. The focused panel still shows everything. The choice lasts until Pi exits, and `piAgents.panelRows` sets the default height, which stays 6.
