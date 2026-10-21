# Architecture

Agents run inside your Pi process on
[pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable),
using your Pi logins and models. See the [overview diagram](../README.md#-architecture)
and [design rationale](./design.md).

## Durability

Agents belong to the Pi session that started them. Quitting, crashing, or
switching sessions pauses them. Resume the original session, for example
with `pi -c`, to continue interrupted work and receive pending results.

Finished graph nodes don't run again, and messages between agents enter
their recipient's conversation once. In-flight model calls or tool effects
may repeat; a tool call that can't safely repeat reports its interruption
to the agent instead.

Pending results aren't lost, but can arrive more than once after a crash
if Pi hadn't saved them, including results a codemode script waited for.

If agent storage fails, agents pause and Pi tells you. They resume when
storage reopens. A second failure within a minute leaves them paused until
you next use them. Sessions started with `--no-session` keep agents in
memory: they end with the session and can't recover from a storage failure.

## Storage

Agents' storage lives in `~/.pi/agent/pi-agents/sessions/<session-id>/`,
with one directory per Pi session, apart from Pi's session file. See
[storage retention](./configuration.md#storage-retention) to limit how long
inactive stores remain.

## Extension lifecycle events

Co-loaded extensions can observe child agents through `pi.events`, without
parsing the panel or footer. These events describe children, not the parent
Pi session's `agent_start` and `agent_settled` lifecycle.

### Creation and request hooks

To capture settings, hold model calls, or transform requests, use
[agent extension hooks](./hooks.md). Unlike the notification events below,
these callbacks can change agent behavior; they don't give agents tools.

### State snapshots

`pi-agents:state` publishes this protocol in every Pi mode:

```ts
type AgentsStateSnapshot = {
  protocol: 1;
  sessionId: string;
  instanceId: string;
  sequence: number;
  type: "snapshot" | "stopped";
  agents: readonly {
    id: string;
    name: string;
    state:
      | "working"
      | "waiting"
      | "idle"
      | "failed"
      | "interrupted"
      | "skipped";
    closed: boolean;
  }[];
};
```

Each `snapshot` replaces the previous state completely. Its entries are
sorted by ID and include visible agents: open agents and closed agents that
are working again, including graph nodes and delegated helpers. It does not
include prompts, results, tool arguments, or other private conversation data.
The payload, agent array, and entries are detached, frozen objects.

The initial snapshot follows session restoration, including when no agents
exist. Further snapshots publish when membership, name, state, or closed
status changes; streaming progress alone does not produce events.

`instanceId` identifies one publisher/session lifetime and changes on reload
or replacement. `sequence` increases within that instance, starting at one;
never compare sequence numbers across different instances. Consumers should
validate the protocol and payload, scope state to the current session and
publisher instance, and discard duplicate or stale sequences within it.

On graceful shutdown, reload, or session replacement, `stopped` clears live
ownership with an empty array. It does **not** mean stored jobs completed:
durable work may resume in a later process. A process crash cannot publish
this reset; consumers must also respect the owning process's lifetime.

### Requesting current state

Register a `pi-agents:state` listener, then emit
`pi-agents:state:request` with `{ protocol: 1 }` to force a current snapshot.
Requests before initialization are satisfied by the initial snapshot.
Malformed requests and unsupported protocol versions are ignored. This
supports both extension load orders and consumers that attach mid-session.
The protocol is notification-only: it does not resume or stop agents.
Don't emit a request from inside a `pi-agents:state` listener: the reply
arrives synchronously and would trigger the listener again.

For a terminal status integration, keep the pane working while the parent
is active **or** any child's state is `working` or `waiting`. A graph
node's `waiting` state means its work is still pending on its inputs, which
can outlast every `working` child, for example while stored work resumes.
It does not mean waiting for the user, so it must not be interpreted as a
blocked user dialog.
