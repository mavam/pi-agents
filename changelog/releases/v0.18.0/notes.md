This release introduces explicit agent profile selectors and a versioned workflow protocol, making reusable orchestration contracts clearer and safer. It also improves workflow launches with resilient presentation handling, quieter previews, and more useful structured result reports.

## 💥 Breaking changes

### Explicit agent profile selectors

Agent nodes and reducers now select reusable agent profiles with `profile`. The old agent-node `name`, reducer `agent`, and flat-workflow `agent` fields are no longer accepted.

Before:

```yaml
kind: agent
name: reviewer
task: Review the change
```

After:

```yaml
kind: agent
profile: reviewer
task: Review the change
```

Reducers and flat single-agent workflows use the same `profile` field. Omit it for an anonymous ad-hoc agent. Parallel branch keys such as `alpha` identify branches and no longer resemble profile selectors. The event and RPC protocol is now version 2, and persisted run records use that same versioned envelope. Records from other protocol versions are ignored.

*By @mavam.*

## 🚀 Features

### Structured results present a conventional report field

Structured workflow results now follow the `report` convention: when a final result contains a top-level `report` string, completion cards and `/workflow <id> result` render it as human-facing Markdown, while the complete structured value remains available to the calling model and parent workflows; `workflow_result` returns it by default. A saved workflow's explicit `display` path still takes precedence, and a missing or non-string path now falls back to `report` before the raw result. Model-facing calls no longer accept `display`.

*By @mavam.*

## 🔧 Changes

### Presentation problems no longer block workflow launches

Invalid request-time `display` and `label` values no longer prevent a workflow from starting. The run falls back to its default presentation, and stray `params` on an inline flow are likewise ignored instead of failing the request. Warnings are stored with the run for later inspection, and RPC start replies include them in the optional `warnings` field.

*By @mavam.*

### Quieter workflow start previews

Starting a workflow no longer adds a `running in background · /workflow …` line to the conversation. The live workflow widget already shows progress, so saved-workflow slash commands and model-started workflows now leave only the workflow invocation preview in the transcript while the run is active.

*By @mavam.*

### The agent catalog advertises only executable profiles

The advertised agent catalog now uses the runtime invocation resolver to check profiles. Profiles with unavailable skills or models, forbidden tools, or another runtime resolution problem are listed separately with the same reason that launch preflight would report. This remains a best-effort check; resources can change after prompt rendering.

*By @mavam.*
