# Agent messaging

Status: experimental, behind the setting `piAgents.messaging`.

Agents of one Pi session send each other one-way messages. This document
states what senders and recipients can rely on, what's deliberately left
out, and what may come next. `docs/design.md` describes the mechanics and
the UI.

## Model

- **Agents** are the top-level agents of a session, including graph agents.
  Helpers are private: they neither send nor receive. The parent session
  isn't an agent here: agents can't message it, and its own messages to
  agents keep working as before.
- **A message** is one-way text from one agent to another. Sending never
  waits for the recipient.
- **Discovery:** `agent_status` lists the agents a sender can message, with
  their state and the task each was started with, so a sender sees what an
  agent is for. Agents that finished stay listed; stopped ones don't.

## Guarantees

- **One recipient, once.** A send binds its recipient when it's first made,
  by identity, not name. It enters that recipient's conversation once, also
  when Pi crashes or restarts in the middle of sending it, and never reaches
  another agent that took the name meanwhile. A new send with the same text
  is a new message.
- **Visible once sent.** A message is logged before it's submitted, so every
  message that reached an agent shows in the UI, also after a crash or a
  cancelled call.
- **Acceptance order.** Messages from one sender to one recipient are
  accepted in the order they were sent. Placement can differ: a steering
  message can enter the conversation before an earlier follow-up. Sends that
  a model makes in parallel within one step have no order among themselves.
- **Timing.** A message steers a working recipient: it joins the current work
  at the recipient's next step, like your own messages. With `followUp`, it
  waits until the current work ends. An idle recipient starts working.
- **No delivery of its own.** A message produces nothing that reaches the
  sender or Pi by itself; agents that want an answer ask the recipient to
  message them. A steer joins the recipient's current work, though, so it can
  shape the answer to whatever the recipient is doing, including the answer
  to its task that Pi receives. Use `followUp` to keep that answer as it is.
- **Stops are final.** An agent you or Pi stopped refuses messages from
  agents until you or Pi message it again. A send and a stop of the same
  agent never interleave: the send lands first and the stop interrupts it,
  or the send is refused.
- **Visible outcome.** Each message is queued (`◷`), delivered once it
  entered the recipient's conversation (`✔`), or dropped (`✘`) when you
  interrupted or stopped the recipient while it was still queued. Delivered
  means it arrived, not that the recipient handled it: a turn that fails
  after a message arrived is the recipient's state, not the message's.
- **Pi's model doesn't see messages between agents.** You see them in the
  transcript, the panel, the attach view, and `/messages`.

## Not provided

- **Requests and replies:** no send that waits for an answer, no time limits.
- **Messages to and from `main`:** agents can't ask you or Pi something
  mid-task, other than in their result.
- **Limits:** no send budgets, hop limits, or caps. Two agents told to keep
  talking keep talking until you stop one. Limits come once loops show up in
  practice.
- **Messages across Pi sessions.**
- **Exactly-once side effects:** what a recipient does with a message
  follows pi-durable's recovery rules, like any other work.

## Next

In order of the evidence each step needs:

1. Use messaging on real multi-agent tasks and note where agents get stuck
   or loop.
2. Replies: an ask that waits for the recipient's answer, with a required
   time limit and refusal of waits that would close a cycle.
3. Messages to `main`: requests that reach Pi at its next safe point, a
   reply box where the first answer wins, and a footer count.
4. Limits, if loops appear.
5. Messaging across Pi sessions through a broker.
