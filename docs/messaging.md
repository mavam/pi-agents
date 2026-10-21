# Agent messaging

Agents in one Pi session can send each other one-way messages.

## Using messages

<img
  src="../demo/messaging.gif"
  width="840"
  alt="Scout messages fixer about a concurrency bug, fixer patches it and
    replies, and Pi browses their exchange in /messages and attaches to both
    agents"
>

Each agent gets `agent_status` to list the agents it can reach and their
jobs, including finished agents but not stopped ones. It can use
`agent_send` to message one of them by name or ID without waiting. An ID
addresses that agent even if another agent has since taken its name, but
doesn't grant access outside the sender's reach. A message steers a working
recipient by default. With `mode: "followUp"`, it waits until the current
work ends; with `mode: "interrupt"`, it first interrupts that work, like Esc
in the attach view. The recipient's answer stays with it.

Pi's agents reach each other. An agent that another agent spawned reaches
that agent and the others spawned with it, and every agent reaches the
agents it spawned. An agent you or Pi stopped refuses messages from agents
until you or Pi message it again. An agent that still waits for the agents
its job needs refuses them until it starts.

Messages appear in your transcript, but Pi's model doesn't see them.
The focused panel shows queued messages. Use ↑↓ to select one, ⏎ to
attach to its recipient, or `m` to open `/messages` at that message.
On an agent row, `m` filters messages by that agent's name.

`/messages` shows every message in one stream, newest first, one line each:

```text
╭─ Messages (3) ───────────────────────────────────────────────────────╮
│   14:33:46 gamma → beta Serve wraps                                  │
│   14:33:17 beta → alpha Location proposal: reserve the central lawn… │
│ ▸ 14:32:47 alpha → gamma Offer two inclusive picnic activities:      │
├──────────────────────────────────────────────────────────────────────┤
│ Offer two inclusive picnic activities:                               │
│                                                                      │
│ - a relaxed nature-scavenger hunt with seated options                │
│ - a collaborative mural                                              │
╰─ ↑↓ move · ⏎ close · ← alpha · → gamma · tab panel · esc close ──────╯
```

Type to filter by text or agent name. ⏎ expands or collapses the selected
message, ← attaches to the sender, and → to the recipient. Esc closes the
message, then clears the filter, then closes `/messages`. Dropped messages
appear in red. A session keeps its latest 1,000 messages.

## Guarantees

- **One recipient, once.** A send binds its recipient when it's first made,
  by identity, not name. It enters that recipient's conversation once, also
  when Pi crashes or restarts in the middle of sending it, and never reaches
  another agent that took the name meanwhile. A new send with the same text
  is a new message.
- **Visible once sent.** Every message that reached an agent appears in the
  UI, including after a crash or cancelled call.
- **Acceptance order.** Messages from one sender to one recipient are
  accepted in the order they were sent. Placement can differ: a steering
  message can enter the conversation before an earlier follow-up. Sends that
  a model makes in parallel within one step have no order among themselves.
- **Timing.** A message steers a working recipient: it joins the current work
  at the recipient's next step, like your own messages. With `followUp`, it
  waits until the current work ends. With `interrupt`, the recipient's
  current work stops first and the message starts its next. An idle
  recipient starts working.
- **Interrupts correct, not end.** An interrupt drops the messages queued
  for the recipient and keeps its job and the agents it spawned, as your
  interrupt does. No other agent's message lands between the interrupt and
  its message, but input from you or Pi can. A send resumed after a crash
  never interrupts the work its message started; one that crashed before
  its message was recorded interrupts again, then sends.
- **No delivery of its own.** A message produces nothing that reaches the
  sender or Pi by itself; agents that want an answer ask the recipient to
  message them. A steer joins the recipient's current work, though, so it can
  shape the answer to whatever the recipient is doing, including the answer
  to its job that Pi receives, and so can an interrupt. Use `followUp` to
  keep that answer as it is.
- **Stops are final.** An agent you or Pi stopped refuses messages from
  agents until you or Pi message it again. A send and a stop of the same
  agent never interleave: the send lands first and the stop interrupts it,
  or the send is refused.
- **Visible outcome.** Each message is queued, delivered once it entered
  the recipient's conversation, or dropped, shown in red, when an interrupt
  or stop of the recipient came while it was still queued. Delivered
  means it arrived, not that the recipient handled it: a turn that fails
  after a message arrived is the recipient's state, not the message's.

## Limitations

- Sends don't wait for replies or have time limits. Ask the recipient to
  message back if you need an answer.
- Peer messages don't wake an agent blocked in `agent_wait`. If a child
  asks its waiting spawner for clarification, the spawner can't answer until
  the wait ends. For interactive coordination, let results arrive
  asynchronously instead of waiting.
- Agents can't message the parent, agents in another Pi session, or
  agents outside their reach.
- There are no send budgets or hop limits. Agents told to keep talking do
  so until you stop one.
- An interrupting send returns once the recipient's work stopped. A tool
  that ignores cancellation holds it up, and other sends to that recipient
  with it.
- An interrupt and its message aren't one atomic step. If the sender's own
  call ends in between, for example because its agent was interrupted or two
  agents interrupted each other, the recipient stays interrupted without
  the message. Like after your interrupt, results owed to it still wait
  for its next answer.
- Exactly-once delivery doesn't guarantee exactly-once side effects; see
  [recovery behavior](./architecture.md#durability).
