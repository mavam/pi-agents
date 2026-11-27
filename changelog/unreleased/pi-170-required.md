---
title: Pi 1.7.0 required
type: breaking
authors:
  - mavam
created: 2026-11-27T19:23:37.51398Z
---

pi-agents now requires Pi 1.7.0 or later, so update Pi before updating pi-agents. The update brings changes that agents benefit from:

- Agents' `codemode` scripts can generate images with Radius through `models.generateImages()`, and image generation reports failed OpenRouter responses as failures instead of success.
- Agents on GitHub Copilot keep the prompt cache when the thinking level changes on supported Claude 5.x and GPT-6 models, and Copilot models on `openai-completions` keep their reasoning state between turns.
- Agents on Amazon Bedrock Kimi K3.1 and GLM 5.3 follow the selected thinking level, and Kimi K3 and K3.1 no longer send earlier reasoning back, which could make later turns fail.
- Agents' model requests now always name Pi as the app to OpenRouter, NVIDIA NIM, and OpenCode, as Pi's own requests do now that Pi 1.7.0 removed the `enableInstallTelemetry` setting and `PI_TELEMETRY`.
