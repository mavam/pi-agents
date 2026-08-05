Pi-agents now validates delegated agent results against the flow’s declared schema before accepting them, making machine-readable workflows safer and more predictable. The release also improves workflow result display and copying, slash-command ergonomics, and saved-workflow previews.

## 🚀 Features

### Copyable workflow results

The TUI can now copy a finished workflow's human-facing result directly:

```sh
/workflow <run-id> copy
```

In the run browser, press `c` on a settled run to copy the same result. Running rows continue to show `c cancel`, while settled runs without a result omit the shortcut.

For workflows with a valid `display` path, both actions copy the selected Markdown string without the surrounding completion metadata or structured routing data. Other workflows fall back to their complete result value.

*By @mavam and @codex in #50.*

### Shifted J/K detail pane scrolling

The `/workflows` and `/agents` panels now accept `Shift+J` and `Shift+K` to scroll the detail pane down or up by one line. Lowercase `j` and `k` continue to move the table selection.

*By @mavam and @codex.*

## 🔧 Changes

### Human-readable and highlighted workflow results

`/workflow <id> result` now shows the workflow's declared human-facing `display` value. Use `/workflow <id> raw` to inspect the complete machine-readable value:

```console
/workflow e5eef505 result
/workflow e5eef505 raw
```

Raw and structured fallback values use JSON-tagged Markdown fences, so Pi applies its native JSON syntax highlighting. String results continue to render as Markdown.

*By @mavam and @codex in #48.*

### Schema-driven delegated agent results

Each delegated agent now completes through a dedicated **Submit Agent Result** tool that pi-agents injects with the result contract declared by its flow node. Previously, pi-agents treated the last assistant message as opaque output and parsed JSON only after the run ended.

Omit `json` for a string or Markdown result. For a machine-readable result, provide a concrete JSON Schema Draft 7 object:

```yaml
kind: agent
task: Review the change.
json:
  type: object
  required: [outcome, report]
  properties:
    outcome: { enum: [approved, changes_required] }
    report: { type: string }
  additionalProperties: false
```

The tool accepts either `{result: payload}` or `{error: {reason: "..."}}`. Pi validates the envelope and payload before accepting them, so the agent can correct an invalid submission. A result terminates the agent and becomes the node value; an error terminates the agent and fails the node with its reason.

Assistant messages remain visible as live progress but never become results. The submission tool also remains available when `tools: []` disables every working tool. An agent that settles without an accepted submission fails instead of falling back to assistant prose.

This is a breaking flow and engine API change. Remove `output: text`; replace each `output: json` with its concrete `json` schema. Custom spawn engines now receive `resultSchema`, return the accepted unwrapped `value`, and use `AgentErrorResult` for an agent-submitted error.

*By @mavam and @codex in #46.*

### Single-argument saved workflow commands

Saved-workflow slash commands now pass all text after the command name to the first declared parameter:

```text
/review this pull request
```

The example binds `this pull request` to `target`; multiword values no longer need quotes. Slash commands no longer parse positional values or `key=value` pairs. Use the model-facing `workflow` tool or RPC when you need to supply multiple named parameters. A required parameter after the first must define a default for direct slash-command invocation.

The workflows panel now keeps workflows that need additional named parameters open and points you to those structured invocation paths instead of composing a slash command that cannot run.

*By @mavam and @codex in #49.*

## 🐞 Bug fixes

### Rooted workflow trees for saved workflows

Saved-workflow commands now show the same parameters and flow-tree preview as model-triggered runs. Named workflows render their steps beneath the workflow title across start previews and workflow details:

```
❖ review
│  target: .
├─ ✦ reviewer · Review the target
└─ ✦ worker · Apply the findings
```

For example, `/review .` now shows the workflow structure when the run starts instead of showing only the run ID.

*By @mavam and @codex in #44 and #47.*
