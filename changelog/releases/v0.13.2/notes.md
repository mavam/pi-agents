This release gives long-running review and repair workflows more room to finish by raising the default delegated-agent turn budget from 100 to 250.

## 🐞 Bug fixes

### Higher default agent turn budget

Delegated agents may now use up to 250 assistant turns by default, up from 100. This gives long-running review and repair workflows enough room to inspect large changes, run checks, and submit their results without being cut off by the default per-agent turn budget. Explicit `maxTurns` limits continue to override the default.

*By @mavam and @codex.*
