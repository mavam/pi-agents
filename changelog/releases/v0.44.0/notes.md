This release upgrades pi-agents to Pi 1.7.0 and aligns agent request identity with Pi’s defaults now that install telemetry has been removed. Agents also benefit from Pi 1.7.0’s model and code mode improvements.

## 💥 Breaking changes

### Pi 1.7.0 required

pi-agents now requires Pi 1.7.0 or later, so update Pi before updating pi-agents. The update brings changes that agents benefit from:

- Agents' `codemode` scripts can generate images with Radius through `models.generateImages()`, and image generation reports failed OpenRouter responses as failures instead of success.
- Agents on GitHub Copilot keep the prompt cache when tools change mid-conversation on supported Claude 5.x models, and Copilot models on `openai-completions` keep their reasoning state between turns.
- Agents on Amazon Bedrock Kimi K3.1 and GLM 5.3 honor supported thinking levels, and Kimi K3 and K3.1 no longer send earlier reasoning back, which could make later turns fail.
- Agents use the same default request identity as Pi, including Pi attribution on OpenRouter, NVIDIA NIM, and OpenCode by default now that Pi 1.7.0 removed the `enableInstallTelemetry` setting and `PI_TELEMETRY`.

*By @mavam in #138.*
