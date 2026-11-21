# Future Trajectory: `pi-durable` and `p3` (Pi Roam)

Reference for tracking upstream `earendil-works/pi` progress, guiding
maintenance of the `coding-agent` shim, and deciding when to port `pi-agents`
to `p3` (Pi Roam).

## Long-Term Picture

- **`packages/coding-agent` (`pi` CLI)** stays on `pi-agent-core` +
  `ExtensionFactory`. The `coding-agent` <-> `pi-durable` bridge (including
  the headless tool twin in `src/host/twin*.ts`) remains necessary for as long
  as `pi-agents` runs inside `coding-agent`.
- **`apps/p3` (Pi Roam)** on `Chord v2` + `pi-durable` (clean-roomed from
  `apps/p2`) is upstream's durable successor: one server per person, one
  `pi-durable` worker per session, server-owned MCP, TUI + web surfaces, and
  hot-reloading plugins (`@earendil-works/p3/v1`).

### Discard vs. Reimplement on `p3`

When `p3` matures into a daily driver:

- **Discard** the `coding-agent` bridge (`src/pi/`, `src/host/twin*.ts`,
  `src/host/hooks.ts`, storage locks, and the custom attach TUI). `p3` runs
  sessions natively on `pi-durable`, shares server-owned MCP across sessions
  and subagents (`slice 13`), and hosts extensions as Chord + Durable plugins.
- **Reimplement / port** the orchestration UX that makes `pi-agents` distinct
  as a `p3` plugin (unless `p3`'s `slice 10` ends up covering it natively):
  - **DAG composition (`after` edges):** single `agent_spawn` for singletons,
    fan-outs, and pipelines, with one merged group result.
  - **Named, reusable durable agents:** agents outlive their initial job and
    accept follow-ups, interrupts, and continues.
  - **Peer-to-peer durable messaging (`agent_send` / `agent_status`):**
    one-way inputs, interrupt-with-message, reachability rules, and a message
    log.
  - **Recursive spawning with bounded budgets:** explicit `spawn: true`,
    depth cap, non-replenishing child budget, cascading stop vs. correction
    interrupt.
  - **Agent profiles:** reusable model, thinking, tools, skills, and
    instruction presets.
  - **Orchestration UX:** compact live tree/panel, attach view, `/agents`, and
    `/messages`.

The orchestration core in `src/agents/` (`graphs.ts`, `messaging.ts`,
`spawning.ts`, `obligations.ts`, `records.ts`) is already pure `pi-durable`
with no `coding-agent` imports. Keep that boundary intact so it ports cleanly
into a `p3` worker plugin (`@earendil-works/p3/v1/worker`).

## Maintenance Posture While on `coding-agent`

- Treat the `coding-agent` tool twin as **feature-complete** (bug fixes only).
- Do not replace the twin with a bespoke `@earendil-works/pi-mcp` runtime
  inside `pi-agents` (more code, same duplicate connections, still needs a
  twin for shared extensions).
- Do not spend effort chasing low-odds `coding-agent` core hooks unless
  upstream signals interest first.
- Keep tracking `@earendil-works/pi-durable` releases so `src/agents/` stays
  aligned with `p3`'s substrate.

## Upstream Status Check

Compare this repository against an up-to-date clone of
[`earendil-works/pi`](https://github.com/earendil-works/pi) (or the remote
repository directly; note the inspected `HEAD` commit and date, and flag if
a local clone is stale).

### 1. `pi-durable` delta

- Compare `@earendil-works/pi-durable` in `package.json` against
  `packages/durable/package.json` and `packages/durable/CHANGELOG.md`
  (`## [Unreleased]` and releases newer than our pinned version).
- Note breaking API changes needing an upgrade PR, and any new primitives that
  simplify `src/host/` (e.g., multi-namespace / per-tool namespaces on one
  `Extension`, or `beforeProviderRequest` covering compaction with error
  propagation).

### 2. `p3` (Pi Roam) readiness gates

Inspect `apps/p3/plugins/`, `apps/p3/README.md`, recent entries at the end of
`apps/p3/docs/decisions.md`, `apps/p3/docs/slices/10-agents.md`, and
`apps/p3/docs/slices/13-mcp.md`. Score these four gates:

1. **Core harness & prompts:** worker Durable harness, models, coding tools,
   and prompt/skills plugins exist (`slices 3 & 8`).
2. **Daily-driver surface:** `p3` is no longer headless (TUI and/or web chat
   works end-to-end).
3. **Native subagents & codemode (`slice 10`):** diff what `p3` ships out of
   the box against `pi-agents`'s DAGs, peer messaging, named agents, recursive
   budgets, and profiles.
4. **Native MCP (`slice 13`) & user plugins:** server-owned MCP works and
   user plugins can contribute Durable tools, tasks, and views via
   `@earendil-works/p3/v1`.

### 3. `coding-agent` & `pi-mcp` delta

- Skim `packages/coding-agent/CHANGELOG.md` and `packages/mcp/CHANGELOG.md`
  for changes affecting `src/host/twin.ts`, `src/host/twin-tools.ts`, or
  `createMcpExtension()`.

### 4. Assessment summary

Cover four points:

1. **`pi-durable` status:** version delta, breaking changes, and whether an
   upgrade PR is warranted.
2. **`p3` readiness:** `X/4` gates met, what landed since the baseline below,
   and any `slice 10` overlap with `pi-agents`.
3. **Port decision:** whether it is time to prototype `pi-agents`'s DAG +
   messaging UX as a `p3` plugin.
4. **`coding-agent` shim status:** any breakage or maintenance needed.

## Baseline Snapshot (2026-11-21)

- **`pi-agents`:** `v0.41.0` + structured output (#130), twin prompt
  contributions (#131), and lazy MCP readiness (#132) on
  `@earendil-works/pi-durable` `1.6.0`.
- **`earendil-works/pi`:** `780bf31fc` (`2026-11-21`).
  - `packages/durable`: `1.6.0` released (`[Unreleased]` has breaking
    tagged-union cleanup `32c71a6d4` and `submit(tx)` -> `admit(tx)`).
  - `apps/p3/plugins/`: 4 headless foundation plugins (`control`, `runner`,
    `sessions`, `sign-in`). **0/4 `p3` port gates met.**
  - `apps/p2`: live proving ground with TUI, native Durable MCP, subagents,
    codemode, and user plugins; `p3` is the clean-room successor.
