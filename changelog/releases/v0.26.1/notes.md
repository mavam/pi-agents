This release shows why an agent tool call failed. Calls cut short by a broken model response now show their error instead of looking like they never finished.

## 🐞 Bug fixes

### Show why agent tool calls failed

Agent tool calls that fail now show why in the transcript. Previously, if the model's response broke off while it was writing a call such as `agent_send`, Pi never ran the call, but the row looked like a normal call with no result, so it seemed to hang. The row now shows the error, such as `terminated`. Errors from calls that ran and failed also show in the error color.

*By @mavam.*
