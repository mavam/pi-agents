# pi-agents

`pi-agents` is a pi extension for durable, named agents built on pi-durable.
See `docs/design.md` for the design and core abstractions.

## Scope

The core is durable agent execution and durable messaging; everything else
is a customization point. `docs/design.md#scope` explains why. A user asking
for a feature is not enough reason to build it here. Before designing new
behavior, decide where it belongs:

1. It makes durable execution or messaging correct, durable, or
   observable: it belongs here.
2. A co-loaded extension can build it with existing hooks, events,
   profiles, or settings: don't add it. Show how the extension does it.
3. Otherwise, propose the smallest hook at a durable boundary, preferably
   one pi-durable already has. The hook passes data and may wait. pi-agents
   doesn't decide, persist, schedule, time, or display the policy behind it.
4. It needs more than that: stop and explain the trade-off to the user
   before writing code.

Never cite existing built-in policy, such as the working-agent cap, as
precedent. When unsure, choose the smaller option and ask.

## Setup

Install Lefthook once per clone:

```bash
uvx lefthook install
```

Pushing runs the quality gates automatically. You don't need to run checks
manually.

## Development

- Keep the docs in sync with user-facing changes: the manual under `docs/`
  (`usage.md`, `graphs.md`, `messaging.md`, `profiles.md`,
  `configuration.md`, `architecture.md`, `hooks.md`) and `docs/design.md` for design
  decisions and their reasons, without implementation details such as file
  paths, module names, or version history. `README.md` keeps only installation, demos, example prompts,
  and the architecture diagram.
- Only `src/host`, `src/agents`, and the attach view (`src/ui/attach.ts`) may
  import pi-durable; everything else goes through `AgentService`.

## Tests

- Keep tests minimal; avoid overly specific regression tests.
- Don't test what Pi or pi-durable already guarantee.
- Don't commit storage fixtures or fakes of Pi or pi-durable internals.

## Release engineering

- Use `tenzir-ship` for changelog management and releasing.
- Add changelog entries for user-facing changes.
- Before releasing, ensure `main` is in sync with `origin/main`.
- To release, dispatch `.github/workflows/release.yaml` with a title and
  introduction.
