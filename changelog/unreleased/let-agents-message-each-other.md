---
title: Let agents message each other
type: feature
authors:
  - mavam
prs:
  - 84
created: 2026-10-10T19:29:31.430902Z
---

Agents can now message each other. Each agent gets `agent_status`, which lists the other agents of the session with their state and the job each was started with, and `agent_send`, which sends one of them a message without waiting. A message steers a working recipient like your own messages do, so it can change what the recipient answers, also to Pi, unless the sender queues it as a follow-up. A message gets no answer of its own, so agents reply by messaging back. Helpers can't send or receive messages, and an agent you or Pi stopped refuses messages from agents until you or Pi message it again.

Every message shows as a card marked `✦` with sender and recipient: in the transcript, where Pi's model doesn't see it, and in the attach view instead of your input. The focused panel shows messages still waiting in their recipient's queue, next to the agents or below them in narrow terminals, with how long they waited. The new `/messages` command shows every message in one stream, newest first, with its time; typing filters it, ⏎ opens a message in full below the list, and ← or → attaches to its sender or recipient. `m` in the panel or `/agents` opens it filtered by the selected agent. In `/messages`, a message that interrupting or stopping its recipient dropped shows in red. A message reaches the agent it was sent to once, also when Pi restarts in the middle of sending it, and always shows in the UI.
