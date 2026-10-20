# Agent extension hooks

Co-loaded Pi extensions can capture state when agents are created and modify
their model requests. Pi-agents has no dependency on any consumer extension.
With no registrations, agent behavior stays unchanged.

## Register hooks

Register a listener in your extension factory. Pi-agents discovers callbacks
when the session starts, after all extension factories have loaded, and again
on reload or session replacement.

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentHooksDiscovery } from "pi-agents/hooks";

export default function (pi: ExtensionAPI) {
  pi.events.on("pi-agents:hooks:discover", (value) => {
    const discovery = value as AgentHooksDiscovery | undefined;
    if (discovery?.protocol !== 1 || typeof discovery.register !== "function")
      return;
    discovery.register({
      namespace: "my-extension",
      onAgentCreate: ({ parent }) => ({
        version: 1,
        owner: parent.sessionId,
      }),
      onAgentRequest: ({ state, model }, payload) => {
        // Read your stored state and return a provider-specific replacement.
        // Undefined leaves the payload unchanged.
        return undefined;
      },
    });
  });
}
```

The import from `pi-agents/hooks` is type-only. Consumers can implement the
same structural contract without importing or depending on pi-agents.

Registration is synchronous. Call `register` before the listener returns;
registrations after discovery finishes are ignored. Late-loaded registrations
require a reload. Duplicate namespaces or malformed registrations make agents
unavailable for that session rather than silently choosing one. Namespaces
start with an ASCII letter or digit, contain only letters, digits, `.`, `_`,
`/`, or `-`, and are at most 128 characters.

## Capture state

`onAgentCreate(ctx)` runs synchronously for each top-level agent after spawn
validation and before its creation commit. It receives:

- `ctx.spec`: a detached, frozen copy of the resolved spawn specification.
  The requested name is not necessarily the final claimed name, and no agent
  ID exists yet.
- `ctx.parent.sessionId`: the owning Pi session.
- `ctx.parent.branch`: a detached, frozen snapshot of its active branch,
  including custom entries. Use this rather than cached `session_start` state
  to recover branch-local settings.

Return JSON or `undefined`. Pi-agents stores JSON under your namespace in the
agent's durable record, outside its prompt and the parent's transcript. Use a
version field inside your state if its format may evolve. Don't store secrets:
state is persisted in agent storage, not an encrypted credential store.

State must contain only plain objects, arrays, finite numbers, strings,
booleans, and null. Cycles, promises, functions, class instances, and nested
`undefined` values are rejected. Depth is limited to 32 and the combined
namespace map to 64 KiB per agent. Returned values are detached before storage.

Creation callbacks are snapshot operations, not exactly-once side effects:
a failed spawn can be attempted again. A thrown error or invalid state fails
creation. For graphs, every node's callback runs synchronously before the
single creation commit, so failure creates no partial graph.

### Inheritance

- Graph nodes capture at graph creation, even if they start later.
- Helpers copy their creating agent's entire state map without invoking
  creation callbacks.
- Follow-ups, retries, compaction, stop/reopen, and session recovery retain
  the stored state. Parent changes affect future top-level spawns only.
- Existing agents without state are not backfilled.

## Transform requests

`onAgentRequest(ctx, payload)` runs when the provider has built a generation
or compaction request. It can return a replacement synchronously or through
a promise. `undefined` preserves the incoming payload; any other value,
including `null`, replaces it.

The context contains:

| Field | Meaning |
| --- | --- |
| `sessionId` | Owning Pi session |
| `agent.id`, `agent.name` | Committed agent identity |
| `model.provider`, `model.api`, `model.id` | Actual dispatched model, after routing |
| `state` | Your namespace's detached, deeply frozen JSON, or `undefined` |
| `signal` | The child request's abort signal, when available |

The existing provider `onPayload` callback runs first, followed by extension
hooks in lexicographic namespace order. Each hook sees the preceding result.
Request hooks run even without stored state, which supports stateless
integrations. Stateful consumers should explicitly handle `undefined`.

Hook errors fail the request instead of silently sending the original payload.
Pi-agents labels the error with the namespace and hook name without including
state or payload contents. Async hooks should honor the signal. Cancellation
ends the host's wait but cannot forcibly stop arbitrary extension code.
Callbacks can run more than once if a provider rebuilds a request, so make
them idempotent and avoid mutating payloads retained by other code.

These hooks do not run for the parent, classifier/image calls, router-internal
calls, or deferred polling. Custom providers must honor Pi's `onPayload`
contract. Request purpose is not exposed.

## Optional consumers

If an extension is absent, its stored state remains intact but no callback
applies it. Pi-agents issues no warning and never substitutes current settings.
Loading the extension again restores its ability to interpret that state.
A present consumer should reject unsupported state versions explicitly.

For example, a compatible pi-service-tier version can capture the parent's
provider-specific defaults and `/fast` overrides at creation and apply them
to each child's actual provider. Tier names, mappings, and configuration stay
entirely in that extension; pi-agents only stores and supplies its state.
