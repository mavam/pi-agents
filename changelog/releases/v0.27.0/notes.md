Agents now find your skills the way Pi does, and Pi can choose which skills each agent gets. Project profiles now come from the directory where you start Pi.

## 🚀 Features

### Choose skills for each agent

Pi can now name the skills an agent gets, so you can ask for an agent that works with particular skills:

```text
Have an agent write the release notes with the technical-writing skill.
```

The agent gets those skills in full instead of the whole skill catalog, and an empty list gives it none. The skills of a profile work the same way, and named skills replace them. Agents that delegate can name skills for their helpers.

Skills marked `disable-model-invocation: true` stay yours to invoke: Pi and agents can't name them. To give agents such a skill, name it in a profile:

```md
---
name: reviewer
description: Reviews changes with the code-review skill
skills: [code-review]
---
```

*By @mavam in #79.*

## 🔧 Changes

### Project profiles come from the working directory

Project profiles now come from `.pi/agents` in the directory where you start Pi, the same place Pi reads the project's skills and settings from. Before, pi-agents searched parent directories for the nearest `.pi`, so a session started in a subdirectory could pick up a profile whose project skills it couldn't find. If you start Pi in a subdirectory and relied on the parent's profiles, start it in the project root or move the profiles to `~/.pi/agent/agents`.

*By @mavam in #79.*

## 🐞 Bug fixes

### Agents see all of your skills

Agents now find skills where Pi does. Before, they missed the skills in `~/.agents/skills`, in a project's `.agents/skills`, and from packages, and in an untrusted project they got no skills at all. Now an untrusted project only keeps its own skills out.

Skills that exist only in the running session, such as those from `--skill`, still don't reach agents.

*By @mavam in #79.*
