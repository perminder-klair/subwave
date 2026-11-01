# `subwave` — operator CLI

A single self-contained binary for installing and running a SUB/WAVE station.
No clone, no Node on the host: it carries the compose files inside itself and
materialises them into an install directory.

Everything here is optional. The CLI drives the same compose files and the same
`state/` layout as raw `docker compose` — see the root [`README.md`](../README.md)
for the no-CLI path.

## Install

```bash
curl -fsSL https://cli.getsubwave.com | sh
```

The binary lands in `/usr/local/bin` (escalating with sudo if needed; pass
`--dir ~/.local/bin` to avoid that) and the installer offers to run `init` +
`start`. After that:

```bash
subwave setup        # connect Navidrome + your LLM
subwave status       # is it on air?
```

`subwave self-update` replaces the binary with the latest release. `subwave
uninstall` tears the stack down and removes the install, keeping `state/` unless
you pass `--purge`.

## Commands

| Command | What it does |
| --- | --- |
| `subwave` | interactive menu (Esc goes back, Ctrl-C exits) |
| `init` | scaffold a fresh install: compose files, `.env`, recorded home |
| `setup` | configuration wizard — Navidrome, LLM, timezone, jingles |
| `start [dev\|prod\|prod-byo]` | `docker compose up -d`; dev also starts the web dev server |
| `stop` | `docker compose down`; dev also kills the web dev server |
| `restart [svc]` | rebuild or restart one service, per the policy below |
| `logs [svc\|all]` | tail compose logs |
| `status` | glance-able stack + now-playing snapshot |
| `doctor` | full diagnostic sweep — host, compose, controller, Icecast, state, logs |
| `update` | pull new images and recreate what changed |
| `sync` | refresh compose files that have fallen behind this binary (`--check` to dry-run) |
| `listen` / `admin` | open the player or admin console in a browser |
| `self-update` | replace this binary with the latest release |
| `uninstall` | tear down and remove the install |

`subwave --help` has the full flag list. `--home <path>` overrides the install
location for a single invocation.

`init` takes `--yes` for a fully non-interactive scaffold, which is what the
`curl | sh` installer uses — see [Prompts and piped stdin](#prompts-and-piped-stdin).

## Where the install lives

Commands resolve `SUBWAVE_HOME` on first use, highest priority first:

1. `--home <path>`
2. `SUBWAVE_HOME` in the environment
3. `home` in `~/.config/subwave/config.json` (written by `init`)
4. the current directory, if it has a `docker-compose.yml`
5. `~/subwave`, if it exists

Step 4 is what makes `cd subwave-repo && npm start` work in a clone with no
config at all. If none match, the command points you at `subwave init`.

Two shapes of install exist and several commands branch on the difference:

- **Standalone** — `docker-compose.yml` + `.env` + `state/`, images pulled from
  GHCR. Nothing to build from source.
- **Clone** — a git checkout with `controller/` and `web/` alongside. `start dev`,
  local rebuilds, and the host-side web dev server only exist here.

## Notes for contributors

Run from source with `tsx`; there is no build step for development:

```bash
npm install
npx tsx src/cli.ts status
npm run typecheck        # tsc --noEmit
```

There are no unit tests, and CI does not typecheck this package — `lint.yml`
covers `controller/`, `web/` and `mcp-subwave/` only. Run `npm run typecheck`
yourself before pushing. Two CI jobs do look at `cli/`: the embedded-asset check
below, and `cli-smoke.yml`, which compiles the binary on a pull request and runs
`scripts/smoke-update-pin.sh` against it.

### Embedded assets

`src/assets.generated.ts` holds the repo-root compose files and `.env.example`
as string constants, because a compiled binary can't read the repo at runtime —
`init` writes those strings into the operator's install directory.

**After editing any root compose file or `.env.example`, regenerate and commit:**

```bash
npm run embed-assets
```

CI fails if the committed copy is stale. Import from `src/assets.ts`, never from
the generated module directly.

Because `init` writes those files once and nothing rewrites them afterwards, an
install scaffolded before a service existed keeps a compose file without it —
hence `sync`, and the drift warnings in `update` and `doctor` that point at it.

### Version pinning

`init` writes `SUBWAVE_VERSION=<this CLI's release>` into the install's `.env`,
so images track the binary rather than floating on `:latest` and drifting ahead
of the frozen compose files it carries. `update` moves that pin forward. A dev
build has no published tag and stays on `:latest`.

A compiled binary loads the working directory's `.env` into `process.env` at
boot, which a `tsx` run doesn't, and compose prefers the environment over `.env`.
So `update` has to move the pin in `process.env` as well as in the file, or a run
from the install directory hands `pull` and `up` the old version (#2196). Only a
compiled binary can show this, so that's what the regression check runs against:

```bash
npm run build:linux-x64
scripts/smoke-update-pin.sh dist/subwave-linux-x64
```

`CLI_VERSION` is baked in at embed time and carries an
`x-release-please-version` marker so release-please bumps it during the release
PR. Keep the marker on the same line as the version.

### Prompts and piped stdin

On macOS, Bun's `process.stdin` delivers no bytes when the binary is launched
from a piped parent ([oven-sh/bun#13374](https://github.com/oven-sh/bun/issues/13374)) —
exactly the `curl … | sh` path. A prompt renders and then hangs un-killably.

Three things guard against it, and they work together:

- `src/tty.ts` opens `/dev/tty` directly and hands it to Clack as the prompt's
  `input`, sidestepping `process.stdin`.
- `scripts/patch-clack.mjs` runs at build time, because `@clack/prompts`'
  high-level wrappers don't forward that `input` option.
- `src/ui.ts` arms a watchdog on the first prompt, but only when launched from a
  piped parent, turning any remaining hang into a fast, actionable exit.

The installer avoids the problem entirely by using `init --yes`, which prompts
for nothing. Keep it that way.

### Restart policy

`restart` encodes the rebuild-vs-restart split from the root
[`CLAUDE.md`](../CLAUDE.md): the controller COPYs its source at build time, so a
plain restart reruns the same code and it always needs a rebuild; broadcast
bind-mounts `radio.liq` in dev but bakes it in prod. On a standalone install
there is nothing to build from, so a wanted rebuild degrades to
`up -d --force-recreate` — which bounces the container and re-reads `.env`.

### Building binaries

Bun compiles one self-contained executable per target:

```bash
npm run build:all           # linux + darwin, x64 + arm64 → dist/
npm run build:linux-x64     # or just one
```

`prebuild` runs `embed-assets` and `patch-clack` first, so a build always
carries current assets.

### Layout

```
src/
  cli.ts            argv parsing and dispatch
  menu.ts           interactive menu loop
  commands/         one file per command
  compose.ts        which compose file is up; URL helpers per env
  docker.ts         docker compose wrappers
  api.ts            controller HTTP client (admin auth from .env)
  doctor.ts         diagnostics as pure data; commands/doctor.ts renders it
  compose-sync.ts   drift detection + re-materialisation
  home.ts           SUBWAVE_HOME resolution
  probes.ts         Navidrome / LLM reachability checks for the wizard
  ui.ts, tty.ts     Clack + colour, and the stdin workaround
```
