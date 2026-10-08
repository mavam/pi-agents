# pi-agents

`pi-agents` is a pi extension for durable, named agents built on pi-durable.
See `docs/design.md` for the design and core abstractions.

## Setup

Install Lefthook once per clone:

```bash
uvx lefthook install
```

Pushing runs the quality gates automatically. You don't need to run checks
manually.

## Development

- Use Bun as the runtime and package manager.
- Keep `README.md` and `docs/design.md` in sync with user-facing changes.
- Add or update tests when changing agent behavior, delivery, or the UI
  formatting.
- Only `src/host`, `src/agents`, and the attach view (`src/ui/attach.ts`) may
  import pi-durable; everything else goes through `AgentService`.

## Release engineering

- Use `tenzir-ship` for changelog management and releasing.
- Add changelog entries for user-facing changes.
- Before releasing, ensure `main` is in sync with `origin/main`.
- To release, dispatch `.github/workflows/release.yaml` with a title and
  introduction.
