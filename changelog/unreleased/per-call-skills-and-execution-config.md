---
title: Per-call skills and execution configuration
type: feature
authors:
  - mavam
  - claude
prs:
  - 24
created: 2026-07-28T13:05:00.000000Z
---

Any agent invocation can now select its own skills and tools, whether or not it names a profile. Skills used to be reachable only by writing an agent file, which pushed you into creating a profile for a one-off delegation:

```json
{ "kind": "agent", "task": "Review the diff in src/run", "skills": ["code-review"] }
```

A named call inherits its profile's skills when `skills` is omitted, and an explicit list replaces the profile's rather than adding to it — so `skills: ["gh"]` swaps the list and `skills: []` clears it. `tools` behaves the same way, with `[]` still meaning no tools at all. Reducers gained the full option set too (`model`, `thinking`, `skills`, `tools`, `cwd`, `scope`), and the flat saved-workflow form normalizes all of them, so the same configuration is expressible in an inline flow, a saved flow tree, a flat workflow, and a reducer.

An unresolvable skill is now a configuration error rather than a silent omission. Previously a stale name appended a `Missing skills (not found)` line to the delegated prompt and the agent ran anyway; now the run fails during preflight, before anything spawns, naming the node and what was available:

```
cannot start run: at $.steps[1], unknown skill 'code-reveiw'
(cwd: /repo, scope: project). Available: code-review, gh
```

Skill discovery follows `scope` exactly as profile discovery does, so an untrusted project — clamped to user scope — can no longer contribute skills. All project resources now resolve from one project root, the nearest ancestor of the cwd holding a `.pi` directory; profiles, skills, and workflows previously walked up independently, which let a run combine a parent project's profile with a nested project's skills.
