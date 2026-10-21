# Agent extension hooks

Co-loaded Pi extensions can capture state when agents are created, hold their
model calls, and modify their model requests. Pi-agents has no dependency on
any consumer extension. With no registrations, agent behavior stays
unchanged.

The hooks carry data and wait; they don't decide anything. Policy, such as
when to hold calls, why, and how users override it, stays in your extension.

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
require a reload. Pi removes an extension's `pi.events` listeners on reload
and session replacement; extensions that also support older Pi versions
should unsubscribe in `session_shutdown`.

Namespaces start with an ASCII letter or digit, contain only letters, digits,
`.`, `_`, `/`, or `-`, and are at most 128 characters. Pi-agents ignores
malformed registrations and every registration of a namespace that more than
one extension claims, and reports both in one notice. Agents keep working; an
ignored namespace behaves like an absent extension.

## Capture state

`onAgentCreate(ctx)` runs synchronously once per spawn, after spawn
validation and before the creation commit. A single agent and a whole graph
are one spawn each, so a graph's nodes share one snapshot. It receives:

- `ctx.parent.sessionId`: the owning Pi session.
- `ctx.parent.branch`: a detached, frozen snapshot of its active branch at
  creation, including custom entries. Use this rather than cached
  `session_start` state to recover branch-local settings. Pi-agents copies
  the branch only when a callback reads it, and then once for all callbacks.

The context describes the parent, not the new agent: its model and provider
are known only per request, possibly after routing.

Return JSON or `undefined`. Pi-agents stores JSON under your namespace in the
agent's durable record, outside its prompt and the parent's transcript. Use a
version field inside your state if its format may evolve. Don't store secrets:
state is persisted in agent storage, not an encrypted credential store.

State must contain only plain objects, arrays, finite numbers, strings,
booleans, and null. Cycles, promises, functions, class instances, and nested
`undefined` values are rejected. Depth is limited to 32 and the combined
namespace map to 8 KiB per agent. Returned values are detached before storage.

Creation callbacks are snapshot operations, not exactly-once side effects:
a failed spawn can be attempted again. A thrown error or invalid state fails
creation. For graphs, callbacks run before the single creation commit, so
failure creates no partial graph.

### Inheritance

- Graph nodes share the snapshot captured at graph creation, even if they
  start later.
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

Hooks run in lexicographic namespace order, and each sees the preceding
result. Should the agent runtime ever pass a payload callback of its own, that
callback runs before them. Request hooks run even without stored state, which
supports stateless integrations. Stateful consumers should explicitly handle
`undefined`.

Hook errors fail the request instead of silently sending the original payload.
The agent's error names the namespace and hook and includes the message of a
thrown `Error` or string, shortened to one line. Pi-agents never adds state or
payload contents; keep them out of your error messages too. Async hooks should
honor the signal. Cancellation ends the host's wait but cannot forcibly stop
arbitrary extension code.
Callbacks can run more than once if a provider rebuilds a request, so make
them idempotent and avoid mutating payloads retained by other code.

These hooks do not run for the parent, classifier/image calls, router-internal
calls, or deferred polling. Custom providers must honor Pi's `onPayload`
contract. Request purpose is not exposed.

## Hold requests

`beforeAgentRequest(ctx)` runs before each generation request and compaction
summary of an agent, before credentials resolve and the request is built. The
call waits until the callback returns or its promise settles. For example,
hold agents' calls during peak pricing:

```ts
discovery.register({
  namespace: "peak-pricing",
  beforeAgentRequest: async ({ model, signal }) => {
    while (isPeak(model.provider, Date.now())) await sleep(60_000, signal);
  },
});
```

The context contains:

| Field | Meaning |
| --- | --- |
| `sessionId` | Owning Pi session |
| `agent.id`, `agent.name` | Committed agent identity |
| `model.provider`, `model.api`, `model.id` | The agent's model; routing may still dispatch to another |
| `operation` | `generation` or `compaction` |
| `state` | Your namespace's detached, deeply frozen JSON, or `undefined` |
| `signal` | The agent's abort signal, when available |

Holding isn't stopping. A held agent stays working: it receives messages,
and tools it already called finish. Only the held call waits.

Pi-agents keeps nothing about holds: no reasons, schedules, timers, manual
overrides, or status. Your extension owns them, for example with a command
that toggles a hold and a status entry that shows why agents wait.

- **Cancellation.** Stopping or interrupting the agent, stopping its graph,
  and shutting down end the wait, even if the callback ignores the signal.
  Honor the signal so your own code stops too.
- **Errors.** A throw neither holds nor fails the call: pi-agents reports the
  error with your namespace, and the call proceeds. To fail closed, catch
  errors in the callback and keep waiting.
- **Order.** Callbacks run in lexicographic namespace order, each after the
  previous one returned, so a call proceeds once none holds it.
- **Repeats.** The callback runs again for retries and for calls that resume
  after a restart. A compaction that a restart resumes mid-summary passes
  without it, and so does deferred polling.
- **Working-agent cap.** Callbacks run before an agent takes a slot. A run
  held at its first call takes none, but an agent held later in its run
  keeps its slot, so other agents may wait behind it.

Like the other hooks, it doesn't run for the parent or for classifier and
image calls.

## Optional consumers

If an extension is absent, its stored state remains intact but no callback
applies it. Pi-agents issues no warning and never substitutes current settings.
Loading the extension again restores its ability to interpret that state.

Snapshots never change, so a consumer must keep reading every state shape it
ever wrote. Reject an unknown state `version` explicitly, but within a known
version ignore fields and values you don't recognize. An older consumer then
still reads what a newer one wrote, and no agent fails every request over
state nobody can repair.

For example, a compatible pi-service-tier version can capture the parent's
provider-specific defaults and `/fast` overrides at creation and apply them
to each child's actual provider. Tier names, mappings, and configuration stay
entirely in that extension; pi-agents only stores and supplies its state.
