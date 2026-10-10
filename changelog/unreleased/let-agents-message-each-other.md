---
title: Let agents message each other
type: feature
authors:
  - mavam
prs:
  - 84
created: 2026-10-10T19:29:31.430902Z
---

Agents can now message each other. Turn it on with the experimental setting `piAgents.messaging: true` and restart Pi. Agents started afterwards get `agent_status`, which lists the other agents of the session with their state and the task each was started with, and `agent_send`, which sends one of them a message without waiting. A message steers a working recipient like your own messages do, so it can change what the recipient answers, also to Pi, unless the sender queues it as a follow-up. The recipient's answer stays with it and never reaches Pi, so agents reply by messaging back. Helpers can't send or receive messages, and an agent you or Pi stopped refuses messages from agents until you or Pi message it again.

Messages show next to the agents in the panel, or below them in narrow terminals, with `◷` while queued, `✔` once delivered, and `✘` when interrupting or stopping the recipient dropped them. In the focused panel, ↑↓ reach the messages, ⏎ opens a message's thread, `m` shows or hides messages, and `v` switches between the views. The new `/messages` command lists threads, everything two agents sent each other, with each thread's messages in full, and an agent's details in `/agents` list its threads. The transcript shows each message as a card that Pi's model doesn't see, and the attach view shows incoming messages as cards instead of your input. A message reaches the agent it was sent to once, also when Pi restarts in the middle of sending it, and always shows in the UI.
