---
title: Classifier and image models in agent scripts
type: feature
authors:
  - mavam
prs:
  - 102
created: 2026-10-16T08:13:11.134927Z
---

Codemode scripts of agents now get `models`, as in Pi: they can list the models you can use, run classifiers with `models.classify()`, and generate images with `models.generateImages()`. These calls count toward the agent's usage, and a restart doesn't repeat the ones that finished.

Only agents with `codemode` get them, and helpers only when they get `codemode` from an agent that has them. Agents created by earlier versions get them the next time you open their session.
