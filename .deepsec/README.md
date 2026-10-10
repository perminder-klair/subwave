# deepsec

This directory holds the [deepsec](https://www.npmjs.com/package/deepsec)
config for the parent repo. Checked into git so teammates inherit
project context (auth shape, threat model, custom matchers); generated
scan output is gitignored.

Currently configured project: `subwave` (target: `..`).

## Setup

1. `pnpm install` — installs deepsec.
2. Add an AI Gateway / Anthropic / OpenAI token to `.env.local`. If
   you already have `claude` or `codex` CLI logged in on this
   machine, you can skip the token for non-sandbox runs (`process` /
   `revalidate` / `triage`); deepsec auto-detects and reuses the
   subscription. See
   `node_modules/deepsec/dist/docs/vercel-setup.md` after install.
3. `data/subwave/INFO.md` is already filled in. Keep it current when
   a new public route, gate, import path or outbound fetch lands — it
   is the threat model every `process` batch is judged against.

## Daily commands

```bash
pnpm deepsec scan
pnpm deepsec process     --concurrency 2 --filter controller/src/routes/
pnpm deepsec revalidate  --concurrency 2                  # cuts FP rate
pnpm deepsec export      --format md-dir --out ./findings
```

The agent (`claude`) and model (`claude-opus-5-5`) are pinned in
`deepsec.config.ts`; `--agent` / `--model` override them.

`--project-id` is auto-resolved while there's only one project in
`deepsec.config.ts`. Once you've added a second project, pass
`--project-id subwave` (or whichever id you want) explicitly.

`scan` is free (regex only). `process` is the AI stage. On this repo
it measured **about $1 per file** on Opus 5.5 (2026-10-09: 103 files,
about 3½ h), because the agent follows imports across the codebase.
A full scan has ~790 candidate files, so scope a run with `--filter` /
`--only-slugs` / `--limit`. A logged-in `claude` CLI spends
subscription quota instead of money.

Keep `--concurrency` low: each worker is its own agent process. On an
11 GB machine a run at 4 was stopped for low memory, and 2 finished.
Interrupted files are picked up automatically by the next run.

Run state goes to `data/subwave/`.

## Adding another project

To scan another codebase from this same `.deepsec/`:

```bash
pnpm deepsec init-project ../some-other-package   # path relative to .deepsec/
```

Appends an entry to `deepsec.config.ts` and writes
`data/<id>/{INFO.md,SETUP.md,project.json}`. Open the new SETUP.md
in your agent to fill in INFO.md.

## Layout

```
deepsec.config.ts        Project list + the inline plugin wiring matchers/
matchers/                Custom matchers for .sh and .liq (no built-in covers them)
data/subwave/
  INFO.md                Repo context — checked into git, hand-curated
  config.json            ignorePaths / priorityPaths / promptAppend (scan reads ONLY this)
  project.json           Generated (gitignored)
  files/                 One JSON per scanned source file (gitignored)
  runs/                  Run metadata (gitignored)
  reports/               Generated markdown reports (gitignored)
AGENTS.md                Pointer for coding agents
.env.local               Tokens (gitignored)
```

## Docs

After `pnpm install`:

- Skill: `node_modules/deepsec/SKILL.md`
- Full docs: `node_modules/deepsec/dist/docs/{getting-started,configuration,models,writing-matchers,plugins,architecture,data-layout,vercel-setup,faq}.md`

Or browse on
[GitHub](https://github.com/vercel/deepsec/tree/main/docs).
