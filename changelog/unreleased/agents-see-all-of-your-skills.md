---
title: Agents see all of your skills
type: bugfix
authors:
  - mavam
prs:
  - 79
created: 2026-10-10T08:01:23.342762Z
---

Agents now see the same skills as your Pi session. Before, they missed the
skills in `~/.agents/skills`, in a project's `.agents/skills`, and from
packages, and in an untrusted project they got no skills at all. Now an
untrusted project only keeps its own skills out.
