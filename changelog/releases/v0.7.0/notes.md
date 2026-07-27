Pi Agents now lets you watch a delegated agent’s live activity and assistant output from the workflows overlay, and steer it without leaving the run view. It also delivers complete workflow results up to 200,000 characters, so longer outputs remain available when a run finishes.

## 🚀 Features

### Live agent activity tails

The workflows overlay now lets you watch a delegated agent's assistant output and tool activity while it runs. Drill into a run's agents and press `t` to open the auto-following tail, then press `s` to steer the agent without leaving the view.

The tail is bounded and kept only for the current session, preserving the final agent message as the workflow's sole durable result.

*By @mavam and @codex.*

## 🔧 Changes

### Expanded workflow result delivery

Workflow results now send up to 200,000 characters to the calling model, replacing the previous 600-character background and 16,000-character foreground limits. Step-to-step interpolation uses the same ceiling, and oversized results point to `/workflow <id> result` for complete retrieval. Completion cards retain a compact preview, while explicit run and per-agent result inspection returns the complete persisted value.

*By @mavam and @codex in #21.*
