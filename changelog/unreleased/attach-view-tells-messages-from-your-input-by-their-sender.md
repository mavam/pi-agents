---
title: Attach view tells messages from your input by their sender
type: bugfix
authors:
  - mavam
prs:
  - 108
created: 2026-10-19T07:12:10.937314Z
---

The attach view now tells messages from other agents apart from what you typed by the sender stored with each message, not by the text. A message you send that starts like `[from <name>]` shows as your own input, and Esc returns it to the editor with the rest of your queued input. Agents still read the sender from the `[from <name>]` and `[user]` markers. Inputs that earlier versions stored carry no sender, so the attach view shows them as plain input with their markers.
