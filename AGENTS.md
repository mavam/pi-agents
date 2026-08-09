# pi-agents

`pi-agents` is a pi extension for explicit, composable multi-agent workflows.

## Setup

Install Lefthook once per clone:

```bash
uvx lefthook install
```

Pushing runs the quality gates automatically. You don't need to run checks
manually.

## Development

- Use Bun as the runtime and package manager.
- Keep `README.md` and bundled workflow examples in sync with user-facing
  changes.
- Add or update tests when changing the workflow algebra or runtime behavior.

## Release engineering

- Use `tenzir-ship` for changelog management and releasing.
- Add changelog entries for user-facing changes.
- Before releasing, ensure `main` is in sync with `origin/main`.
- To release, dispatch `.github/workflows/release.yaml` with a title and
  introduction.
