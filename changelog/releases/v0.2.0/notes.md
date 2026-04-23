This release improves agent and workflow monitoring with live summaries, simpler flow statuses, and refreshed flow icons. It also restores compatibility with pi 0.69 and later by updating schemas, session handling, skill loading, and expand hints for the current extension APIs.

## 🔧 Changes

### Improve live flow and agent summaries

Foreground agent and workflow runs now keep a live summary visible instead of falling back to the generic working indicator. The foreground renderer updates in place with a spinner, token usage, wall-clock runtime, and a one-line preview of the latest output.

The above-editor flows widget now stays visible only while flows are actively running, and disappears once they finish so the final summaries live in the conversation and notifications instead.

Live flow watching and flow summary rendering now use the same public spinner cadence and frame sequence as pi's built-in loader.

This change also resets persisted flow-event history to a new event stream format instead of carrying compatibility code for older session data.

*By @mavam and @codex.*

### Simplified flow statuses and updated flow icons

Flow inspection now uses a simpler public state model with four statuses: `waiting`, `running`, `completed`, and `stopped`. The previous `queued`, `failed`, and `aborted` labels are no longer shown in the flow UI, and `/flows`, `/flow`, and live workflow widgets now use one consistent icon palette.

Status overlays now render as:

- `○` waiting
- `◉` running
- `●` completed
- `⊘` stopped

Flow structure icons were also refreshed to make the control-flow tree easier to scan:

- `✦` spawn
- `⑃` fork
- `⑂` join
- `↺` loop
- `≡` sequence

This makes workflow trees easier to read at a glance and reduces ambiguity between transient and terminal states when monitoring long-running flows.

*By @mavam and @codex.*

## 🐞 Bug fixes

### Compatibility with pi 0.69

The extension now loads correctly with pi 0.69 and later.

Agent tools, workflow schemas, session refresh handling, skill prompt loading, and expand hints now use the current pi extension APIs, so agent orchestration continues to work after pi’s TypeBox, session event, and TUI updates.

*By @mavam and @codex.*
