Delegated-agent workflows now preserve completed results and restore queued messages when an attached agent is interrupted. The package also removes the bundled review-fix workflow in favor of the read-only review workflow or custom project workflows.

## 🔧 Changes

### Removal of the bundled review-fix workflow

The package no longer bundles the `/review-fix` workflow. Use `/review` for the bundled read-only review, or define a project or user workflow when review findings should trigger code changes.

*By @mavam in #65.*

## 🐞 Bug fixes

### Preserved results for agents that finish without submitting

A delegated agent that completed its work but never packaged it through the result-submission tool previously failed with a generic "finished without submitting a result" error, and the finished report was lost.

Workflow runs now recover and preserve that work:

- A settled agent that produced output without submitting it gets one bounded in-band nudge to package what it already has, without redoing the assignment.
- If the agent still ends without submitting, its final response is preserved as the node's partial result and stays retrievable via `workflow_result` — including through the run-level call when a single node holds the output, and even when the recovery turn itself fails or a stop races the shutdown.
- The node failure now carries a `result-contract` failure kind, so `workflow_inspect` distinguishes an output-packaging failure from a task failure.

*By @mavam.*

### Queued message restoration on agent interrupts

Pressing `Esc` while attached to a delegated agent now returns queued messages to the attached editor before interrupting the turn. The messages keep their original order and appear ahead of any draft already in the editor, matching Pi's main editor.

*By @mavam.*
