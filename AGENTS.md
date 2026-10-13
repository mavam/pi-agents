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

- Keep the docs in sync with user-facing changes: the manual under `docs/`
  (`usage.md`, `graphs.md`, `messaging.md`, `profiles.md`,
  `configuration.md`, `architecture.md`) and `docs/design.md` for design
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
