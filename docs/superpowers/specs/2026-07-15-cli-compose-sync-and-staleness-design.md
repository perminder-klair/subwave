# CLI compose-sync + staleness cleanup — design

**Date:** 2026-07-15
**Branch:** `worktree-cli-compose-sync`
**Issue:** [#1043](https://github.com/perminder-klair/subwave/issues/1043) — "Analyzer container will not start"

## Problem

The standalone `subwave` CLI materialises the embedded compose files + `.env.example` into the install directory **only on `subwave init`**, and refuses to overwrite them. No update path ever refreshes them afterwards:

- `subwave self-update` replaces **only the binary** (`self-update.ts`).
- `subwave update` reads the **on-disk** compose (`update.ts:28`, `:62`) and pulls images; its own comment wrongly assumes "the binary on PATH already has the latest compose file thanks to `subwave self-update`" — but nothing writes the embedded compose to disk.
- `subwave start` reads the on-disk compose too.

So any install scaffolded before a service was added keeps a compose file that lacks it forever. The `analyzer` service was added in **v0.34.0** (#717); post-split the controller resolves acoustic analysis **only** from `ANALYZE_URL` (`controller/src/config.ts:80`) with no tts-heavy fallback. Result for #1043: `docker compose up -d analyzer` → "no such service: analyzer", no analyzer container, library shows "engine off", and `ANALYZER_HEAVY=1` does nothing (no service to switch). Image *tags* float forward via `SUBWAVE_VERSION` + pull, but compose **topology** never does.

This design closes that gap (warn-on-drift + explicit sync) and clears the adjacent CLI staleness the audit surfaced.

## Approach (decided)

- **Detect + warn, sync on demand** — the CLI never silently overwrites a possibly-hand-edited compose. `update` and `doctor` warn when the on-disk files are behind the binary's embedded copies; a new explicit `subwave sync` re-materialises them, backing up any changed file first.
- **Scope:** the core fix **plus** all audit findings (locca in the wizard, uninstall file-set, menu tally, comment/hint drift).
- **Not touched:** versioning (`cli/package.json` 0.40.0 vs project 0.42.0 is develop-lags-main; release-please self-corrects), deps, `patch-clack`, the install script, embedded assets (already in sync).

## Component 1 — `cli/src/compose-sync.ts` (new, the core seam)

Pure, side-effect-free derivations + one writer. This is the unit-testable core.

**`expectedFiles(mode): { name, content }[]`** — the file-set `init` writes, resolved from embedded assets (`assets.ts`):
| file | content | notes |
|---|---|---|
| `docker-compose.yml` | `mode === 'prod-byo' ? COMPOSE_BYO_YML : COMPOSE_YML` | mode-dependent |
| `docker-compose.byo.yml` | `COMPOSE_BYO_YML` | init always writes it |
| `docker-compose.tts-heavy-gpu.yml` | `COMPOSE_TTS_HEAVY_GPU_YML` | GPU overlay |
| `.env.example` | `ENV_EXAMPLE` | reference template |

**`resolveInstallMode(home): 'prod' | 'prod-byo' | null`** — `loadConfig().preferredEnv` when it is `prod`/`prod-byo`; else infer from the on-disk `docker-compose.yml` (`caddy:` service present → `prod`, absent → `prod-byo`); `null` when undeterminable or clone/dev. Backups make a wrong guess recoverable regardless.

**`detectDrift(home, mode): DriftEntry[]`** — `DriftEntry = { name, status: 'fresh' | 'drifted' | 'missing' }`, byte-compare on-disk vs expected. `hasDrift(...) = entries.some(e => e.status !== 'fresh')`.

**`syncFiles(home, mode): SyncResult[]`** — for each expected file: if drifted/missing, back up the existing file (if any) to `<name>.bak-<timestamp>` then write fresh; `.env.example` is refreshed **without** backup (pure template, no operator data). Never touches the live `.env`. Returns `{ name, action: 'created'|'updated'|'unchanged', backup?: path }[]`.

**Guards:** clone installs (`isCloneMode`) and dev return no drift / refuse sync — git owns their compose. The live `.env` is never rewritten; new optional vars surface only via the refreshed `.env.example` (operators diff manually — merging into a secrets-bearing `.env` is out of scope).

## Component 2 — `subwave sync` (new command)

`cli/src/commands/sync.ts` → `runSyncCommand({ check?: boolean })`:

1. Resolve `home` + `mode`. Clone → message ("clone install — `git pull` to refresh compose") + return. `mode === null` → warn, point to `subwave init`.
2. `detectDrift`. No drift → "compose files are up to date." return.
3. Print the drifted/missing files. **`--check`** stops here (dry-run; nonzero exit if drift) for scripting. Otherwise `syncFiles`, print per-file action + backup path, then hint: *"restart to apply: `subwave restart` — or `subwave update` to also pull new images."*

Wire into `cli.ts` dispatch + help text, and add a contextual `sync` entry to `menu.ts` when drift is detected.

## Component 3 — warn hooks

- **`update.ts`** — after "update complete", standalone-only: if `hasDrift`, print a prominent warn block naming the count and pointing at `subwave sync` (backs up first). This is the surface that would have caught #1043.
- **`doctor.ts`** — add a compose-freshness `Finding` to the existing **Compose** section (`checkCompose`), standalone-only: `warn` + hint `run \`subwave sync\`` when drifted; `ok` when fresh; `skip` in clone/dev.
- **`self-update.ts`** — one muted closing line suggesting `subwave sync` if compose is behind.

## Component 4 — staleness cleanup (audit findings)

1. **locca in the setup wizard** (`setup.ts`) — the controller has 10 `LLM_PROVIDERS` incl. first-class `locca` (`settings.ts:280`); the wizard knows 9. locca is openai-compatible transport with a **default** base URL (`http://host.docker.internal:8080/v1`, `registry.ts:206`) and **no API key**, so in the wizard it mirrors the Ollama branch, not the cloud branch:
   - add `'locca'` to the `LlmProvider` union;
   - add to `LLM_PROVIDER_OPTIONS` after `openai-compatible` (same transport family); soften the "same eight/order as admin" comments (`:69`, `:389`) to stop asserting an exact count/order;
   - `collectLlm` locca branch: prompt URL (default `http://localhost:8080/v1`, optional, loopback-swap via `maybeSwapLoopbackForContainer`) + model (required); no key; no probe (like openai-compatible);
   - save block: `provider:'locca'` + `baseUrl` (if set) + `model` (mirror the openai-compatible branch; locca is not in `CLOUD_ENV_VAR`, so no key export — correct);
   - add a `locca` `EXAMPLE_MODEL` entry.
2. **uninstall file-set** (`uninstall.ts:36`) — `GENERATED_FILES`: drop `docker-compose.dev.yml` (init never writes it), add `docker-compose.tts-heavy-gpu.yml` (init writes it). Optionally sweep `docker-compose*.bak-*` sync backups.
3. **menu tally** (`menu.ts:38`) — `holder?.command === 'node'` → `holder && isWebDevCommand(holder.command)` (import from `web-dev.ts`); fixes the Linux undercount (`next-server`).
4. **comment/hint drift** — `init.ts:86` "change install dir / mode" → what setup actually does; `open-web.ts:55` `npm run dev:web` → `npm --prefix web run dev`; refresh stale `EXAMPLE_MODEL` ids (`setup.ts:405`).

## Out of scope

- Versioning / release wiring (release-please owns it; develop simply lags main). Note only: a hand-built dev binary embeds `0.40.0` and would move `SUBWAVE_VERSION` backward — a dev-build-only edge, not shipped. No guard added.
- Merging new keys into the live `.env`. No test framework for the CLI (there is none today).

## Testing

- **Gate:** `npm --prefix cli run typecheck` (`tsc --noEmit`) must pass.
- **Repro #1043 (scratch, uncommitted, under `$CLAUDE_JOB_DIR/tmp`):** scaffold a fake home with an old `docker-compose.yml` (analyzer service removed) + `cli.json` preferredEnv=prod → run `sync --check` (reports drift) then `sync` → assert `analyzer:` now present and a `.bak` was written. Repeat for byo mode and clone-mode no-op.
- Run the CLI in dev via `tsx cli/src/cli.ts <cmd>` (bun-compiled in prod; tsx for local exercise).
- Manual sanity: `sync` on an already-fresh install reports "up to date"; `doctor` shows the new freshness finding.

## File change list

**New:** `cli/src/compose-sync.ts`, `cli/src/commands/sync.ts`.
**Edit:** `cli/src/cli.ts` (dispatch+help), `cli/src/menu.ts` (sync entry + tally fix), `cli/src/commands/update.ts` (drift warn), `cli/src/doctor.ts` (freshness finding), `cli/src/commands/self-update.ts` (hint), `cli/src/commands/setup.ts` (locca + comments + EXAMPLE_MODEL), `cli/src/commands/uninstall.ts` (file-set), `cli/src/commands/init.ts` (hint), `cli/src/commands/open-web.ts` (hint).
