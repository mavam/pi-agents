---
title: Interrupt an agent with the message that corrects it
type: feature
authors:
  - mavam
created: 2026-10-21T15:38:54.055782Z
---

Pi and agents can now interrupt a working agent and send it the correcting message in one step. `agent_send` takes a `mode`: `steer` (the default) joins the agent's current work, `followUp` waits until that work ends, and `interrupt` stops the work first, like Esc in the attach view. An interrupt drops the messages queued for the agent and reports how many. It keeps the agent's job and the agents it spawned.

```json
{ "name": "fixer", "message": "Stop patching the parser; the bug is in the lexer.", "mode": "interrupt" }
```

Agents can interrupt any agent they can message, and stopped agents still refuse both. No other agent's message lands between an interrupt and its message. An agent's send that resumes after a crash never interrupts the work its message already started. The interrupt and its message aren't one atomic step: a crash in between, or a sender that is itself interrupted meanwhile, can leave the recipient interrupted without the message.

`mode` replaces the `followUp` flag of `agent_send`; calls that still set `followUp: true` keep queuing as before.
