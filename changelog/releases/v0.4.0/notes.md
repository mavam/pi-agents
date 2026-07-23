Pi Agents now runs ad-hoc workflow agents without predefined profiles and adds per-agent inspection, live steering, and event-bus control. Reliable delegated completion, uncropped persisted results, stable previews, and compact footer counters make long-running workflows easier to operate.

## 🚀 Features

### Ad-hoc agents in workflows

Inline and saved workflows now run without configuring agent profiles. Omit the agent `name` on a leaf (or `agent` on a reducer) to launch a generic delegated pi process that uses the active session's model and thinking level, the given task, and the normal tool environment:

```json
{
  "flow": {
    "kind": "parallel",
    "branches": {
      "bugs":    { "kind": "agent", "task": "Review src/run for bugs" },
      "clarity": { "kind": "agent", "task": "Review src/run for clarity" }
    },
    "reduce": { "task": "Merge and prioritize:\n{branches}" }
  }
}
```

Saved workflows gain the same power: the flat form now needs only `task:`, and explicit `flow:` trees may use anonymous leaves anywhere. Anonymous agents render as `ad-hoc` in trees, widgets, and Mermaid diagrams. Named agent profiles keep their exact semantics and remain the way to attach a reusable persona, tool allowlist, or skills.

*By @mavam and @claude in #4.*

### Control workflow runs over event-bus RPC

Other pi extensions can now ping pi-agents, start inline or saved workflows, stop live runs, and list current-session run summaries through versioned, request-correlated `pi.events` messages. RPC starts use the same validation, project-trust rules, persistence, budgets, background notifications, and run UI as existing trigger surfaces. Raw channels remain import-free, while the new `pi-agents/api` subpath provides a typed client with timeout and listener cleanup handling.

*By @mavam and @codex in #8.*

### Inspect each agent's output within a run

A run's per-agent outputs are now inspectable, not just the run-level result. In the `/runs` overlay, press `a` on a run to drill into its agents: one row per agent (and reducer) with status and usage, the selected agent's output preview in the detail pane — or a live progress tail while it is still running — `⏎` to post the full output to the chat, and `esc` to step back to the run list.

The command surface gained matching verbs: `/run <id> agents` lists a run's agents with collapsed previews, and `/run <id> result <node>` prints one agent's complete output. Nodes are addressable by display name (`bugs`, `@2`), agent name, or instance path, with tab completion walking id → verb → node name. The run tree now keeps each node's kind glyph and encodes the outcome in its color — green completed, red failed — matching the run rows and the live widget, so both progress and fork/join structure read at a glance; colorless contexts (markdown fences) pair the glyph with a status icon instead.

*By @mavam and @claude in #6.*

### Live workflow agent steering

Running workflow agents can now receive course corrections without being stopped or restarted. In `/runs`, drill into a run's agents and press `s` on a live node to compose a message. Models can use the separate `steer` tool, and other extensions can use the typed client:

```ts
await agents.steer({
  runId,
  instance: "$.branches.reviewer",
  message: "Prioritize the retry failure.",
});
```

The instance may be omitted when exactly one agent in the run is steerable. Accepted messages appear in the node's persisted history with user, tool, or RPC attribution. Messages are limited to 2,000 characters and are delivered after the current assistant turn finishes its tool calls.

*By @mavam and @codex in #10.*

### Optional fancy footer workflow counters

`pi-agents` now offers two compact widgets for `pi-fancy-footer`: `❖N` shows the number of active workflow executions, while `✦A/T` shows completed and total agents across those executions. For example, `❖2 ✦4/7` means two executions are active and four of their seven agents have completed.

Both widgets are off by default and can be enabled independently from `/fancy-footer`. The integration uses the footer's event protocol, so installing `pi-fancy-footer` remains optional.

*By @mavam and @codex in #12.*

### Publish live run events for other extensions

Co-loaded pi extensions can now observe every live workflow lifecycle event on the `pi-agents:run-event` event-bus channel. The versioned envelope carries the existing event-sourced `RunEvent` vocabulary, including expanded flows, node progress, backgrounding, final values, usage, and failures. Published events are detached, deeply frozen snapshots, so a subscriber cannot accidentally mutate pi-agents' internal run state or the event seen by later subscribers. A matching `pi-agents:ready` signal announces the protocol and package version at session start.

*By @mavam and @codex in #8.*

## 🔧 Changes

### Delegated agents are told their final message is the result

An agent's value has always been the text of its last assistant message — but nothing told the agent that. Every delegated agent (ad-hoc ones included) now receives a delegation preamble in its system prompt: the run is non-interactive, only the final message is returned, so end the turn with one dedicated message containing the complete deliverable. With `output: json`, the preamble additionally requests a single raw JSON value, which was previously enforced only by failing the node when parsing choked. The value contract is also documented in the README's `agent` node reference.

*By @mavam and @claude in #6.*

### Leaner workflow tool description

The `workflow` tool now sends its node grammar to the model once per request instead of twice: the `flow` parameter defers to the tool description rather than repeating the full grammar, and the description itself is tighter. This cuts the tool's fixed per-request token footprint by more than half while keeping every node kind, predicate, and binding rule.

*By @mavam and @claude in #11.*

### Run values persist uncropped

Node and run values used to be truncated to 16k characters when written to the sidecar, so large agent outputs were silently cropped after a pi restart. Since the final message is the sole artifact of an agent's work, the sidecar now persists values in full — `/run <id> result` and the per-agent views return the complete output in any later session. The 16k bound still applies where it belongs: to the value embedded in the `workflow` tool result, protecting the calling model's context.

*By @mavam and @claude in #6.*

## 🐞 Bug fixes

### Reliable delegated agent completion

Delegated agents now wait until Pi has fully settled before returning their final response. Automatic retries, context compaction, queued continuations, and nested headless workflows can finish instead of being cut off after the first completed turn. Cancellation and shutdown also stop child processes within a bounded time.

Delegation now uses Pi's current RPC protocol. Update Pi before using this version:

```sh
pi update pi
```

*By @mavam and @codex in #9.*

### Stable streaming workflow previews

Inline `workflow` tool calls no longer flicker between their structured flow tree and a raw JSON blob while arguments stream in. The preview now retains the newest valid tree through temporarily incomplete fields and branches, while completed invalid calls still show the raw diagnostic preview.

*By @mavam and @codex in #7.*

### Wake the agent when a background run completes

Workflow runs launched via the `workflow` tool now resume the outer agent when they complete. Previously the completion notification was only rendered: the tool told the model to end its turn, but the notification arrived without triggering a new one, so the agent never continued its task with the result.

The final notification for tool-launched runs now triggers a new turn and asks the agent to continue with the result. Runs started by slash commands or event hooks keep the previous display-only behavior, so user-initiated runs don't burn tokens on unsolicited commentary and hook-fired workflows can't create feedback loops.

*By @mavam and @claude in #5.*
