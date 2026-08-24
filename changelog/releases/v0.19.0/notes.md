This release makes model selection visible throughout workflow planning and run inspection. It adds per-node model details to live trees and events while helping planners choose models with cost and context-window guidance.

## 🚀 Features

### Cost-aware model planning guidance

The planning prompt now labels available models with price tiers and highlights unusual context windows. You can add model-specific fit notes through the `models` key in `workflows.json`; trusted project notes layer over user guidance, and the appendix stays within a fixed prompt budget.

```json
{
  "models": {
    "claude-opus-*": "planning, reduces, final review"
  }
}
```

*By @mavam.*

### Model labels in workflow trees

Workflow trees now attach compact `@model` labels to pinned agent and reduce nodes. Live run trees show the effective model per path and use `@mixed` when instances on the same path diverge because of fallback behavior.

*By @mavam.*

### Per-node models in run inspection

Live workflow panels, the `/workflows` browser, and `workflow_inspect` now show the model used by each agent node. Compact rows use collision-safe short names, while detail views retain the full effective model, authored model reference, and thinking level.

*By @mavam.*

## 🔧 Changes

### Model identity in run events

Run events now report each agent node's planned model, authored model reference, thinking level, and effective model changes. Extensions subscribed through `pi-agents/api` can use `node_started` for planned identity and `node_model` for the latest model observed during a run. Existing protocol-v2 histories remain compatible because all new identity fields are optional.

*By @mavam.*
