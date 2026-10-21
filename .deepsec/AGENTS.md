# Agent setup

This is a deepsec scanning workspace. `subwave` is already set up — its
`data/subwave/INFO.md` is filled in and its `SETUP.md` was deleted. A
newly registered project gets its own setup prompt at
`data/<id>/SETUP.md`.

## Common tasks

- **Keep `subwave` current**: `data/subwave/INFO.md` is the threat model
  every `process` batch is judged against. Update it when a new public
  route, auth gate, import path or outbound fetch lands, and stay inside
  its 50–100 line budget.
- **Set up a new project for scanning**: read `data/<id>/SETUP.md` and
  follow it (read `node_modules/deepsec/SKILL.md`, then fill
  `data/<id>/INFO.md` from the target codebase).
- **Add a new project**: run `deepsec init-project <root>` — it
  scaffolds `data/<id>/` and prints/writes the setup prompt for the
  new project.
- **Write a custom matcher** (only after a real true-positive shows you
  a pattern worth keeping): read
  `node_modules/deepsec/dist/docs/writing-matchers.md`.

## Reference

The deepsec skill is at `node_modules/deepsec/SKILL.md` (after
`pnpm install`). The full docs ship at
`node_modules/deepsec/dist/docs/`.
