---
title: Cost-aware model planning guidance
type: feature
authors:
  - mavam
created: 2026-08-24T09:01:39.95855Z
---

The planning prompt now labels available models with price tiers and highlights unusual context or reasoning support. You can add model-specific fit notes through the `models` key in `workflows.json`; trusted project notes layer over user guidance, and the appendix stays within a fixed prompt budget.

```json
{
  "models": {
    "claude-opus-*": "planning, reduces, final review"
  }
}
```
