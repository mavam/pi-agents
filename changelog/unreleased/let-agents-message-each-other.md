---
title: Let agents message each other
type: feature
authors:
  - mavam
prs:
  - 84
created: 2026-10-10T19:29:31.430902Z
---

Agents can now message each other. Turn it on with the experimental setting `piAgents.messaging: true` and restart Pi. Agents started afterwards get `agent_status`, which lists the other agents of the session with their state and the job each was started with, and `agent_send`, which sends one of them a message without waiting. A message steers a working recipient like your own messages do, so it can change what the recipient answers, also to Pi, unless the sender queues it as a follow-up. A message gets no answer of its own, so agents reply by messaging back. Helpers can't send or receive messages, and an agent you or Pi stopped refuses messages from agents until you or Pi message it again.

The panel shows messages still waiting in their recipient's queue next to the agents, or below them in narrow terminals, with how long they waited. Every message shows in the transcript as a card with its time, which Pi's model doesn't see, and in the attach view as `← sender` or `→ recipient` instead of your input. The new `/messages` command lists the agents that sent messages, the most recent first, with each one's messages, times, and recipients, and `/` searches them; `m` in the panel or `/agents` opens the selected agent's messages. A message's text is dim while queued, normal once delivered, and red if interrupting or stopping the recipient dropped it. A message reaches the agent it was sent to once, also when Pi restarts in the middle of sending it, and always shows in the UI.
