// `subwave start [dev|prod|prod-byo]` — bring the stack up.
//
// Behaviour:
//   - If a stack is already running, refuse (use `subwave restart` / `stop` instead).
//   - Otherwise resolve the target env silently (no prompt) via this cascade:
//       1. explicit positional arg
//       2. cli.json:preferredEnv  (set by `init`, or by the previous `start`)
//       3. filesystem heuristic   (clone → dev; single compose file → its env)
//     and error out if undecidable (effectively unreachable — an init install
//     hits step 2 and a clone hits step 3).
//   - Shell out to `docker compose up -d` (dev builds locally; prod/prod-byo
//     pull the published GHCR images).
//   - Poll /health for up to 30 s and report when the stream comes on-air.

import {
  getComposeFiles,
  detectCompose,
  inferEnvFromFilesystem,
  runningImageRefs,
  webBaseFor,
  type ComposeEnv,
  type ComposeFile,
} from '../compose.ts';
import { composeUp, dockerSocketPermissionDenied } from '../docker.ts';
import { waitForHealth, checkNeedsSetup } from '../api.ts';
import { loadConfig, saveConfig } from '../config.ts';
import { parseEnvFile, getRootEnv } from '../util.ts';
import { ok, warn, err, info, muted, p, pc, pauseForEnter, header } from '../ui.ts';
import { maybeStartWebDev } from '../web-dev.ts';

// Subset of ComposeEnv the operator can pick — excludes 'down' (no stack
// to start) and matches what the wizard offers in `subwave setup`.
export type StartableEnv = Exclude<ComposeEnv, 'down'>;

export interface StartOpts {
  envArg?: StartableEnv;
}

export async function runStartCommand(opts: StartOpts = {}): Promise<void> {
  const current = detectCompose();
  if (current.env !== 'down') {
    header('Already running');
    info(`stack is already up — env=${current.env}`);
    warnIfVersionMismatch(current.file);
    muted('→ use `subwave restart` to bounce a service, or `subwave stop` first.');
    await pauseForEnter();
    return;
  }

  const target = resolveEnv(opts.envArg);
  if (!target) return;

  // Remember the operator's choice so future no-arg invocations default to it.
  const cfg = loadConfig();
  if (cfg.preferredEnv !== target.env) {
    cfg.preferredEnv = target.env;
    saveConfig(cfg);
  }

  // Dev compose tags `sub-wave-broadcast:local` and has no `image:` on the
  // controller, so it must build locally. Prod / prod-byo reference
  // published `ghcr.io/perminder-klair/subwave-*` images — pull them
  // instead of rebuilding. `--pull always` on prod forces a fresh pull so
  // a stale locally-tagged image doesn't mask the upstream release.
  // Operators can force a rebuild per-service via `subwave restart <svc> --build`.
  const wantBuild = target.env === 'dev';
  const wantPull = target.env === 'dev' ? undefined : ('always' as const);
  header(`Starting ${target.env} stack`);
  const flags = `${wantBuild ? ' --build' : ''}${wantPull ? ` --pull ${wantPull}` : ''}`;
  muted(`docker compose -f ${target.file} up -d${flags}`);
  console.log();

  const code = await composeUp(target, { build: wantBuild, pull: wantPull });
  console.log();
  if (code !== 0) {
    err(`docker compose exited ${code}`);
    // Most common cause we can detect cheaply: the operator's user isn't in
    // the `docker` group, so docker.sock returns EACCES. Without this hint
    // they have to find it themselves (see #156, where the operator ended up
    // `sudo su`-ing as a workaround).
    if (dockerSocketPermissionDenied()) {
      console.log();
      warn(`can't talk to /var/run/docker.sock — your user isn't in the docker group`);
      muted('  fix it once with:');
      muted(`    ${pc.bold('sudo usermod -aG docker $USER')}`);
      muted('  then either log out + back in, or run `newgrp docker` in this shell, then re-run `subwave start`.');
    } else {
      muted('→ `subwave logs <service>` to inspect.');
    }
    await pauseForEnter();
    return;
  }

  // Readiness wait. The controller can take a few seconds to connect to
  // Icecast on cold boot, so 30s is generous.
  const sp = p.spinner();
  sp.start('Waiting for controller to report on-air…');
  const healthy = await waitForHealth(target.env, 30_000, (ms) => {
    sp.message(`Waiting… ${Math.floor(ms / 1000)}s`);
  });
  sp.stop(healthy ? 'Controller on-air' : pc.yellow('Controller not on-air after 30s — continuing'));

  if (healthy) ok('stack ready');
  else warn('stack started but /health is not yet returning on-air');

  // Dev mode: web is a host-side `npm run dev` process, not a compose
  // service. Bring it up here so `start` matches `setup` and the operator
  // doesn't have to remember a second command.
  let webDevState: 'running' | 'skipped' = 'skipped';
  if (target.env === 'dev') {
    webDevState = await maybeStartWebDev();
  }

  console.log();
  if (target.env === 'prod') {
    muted(`→ ${webBaseFor('prod')}   (stream: /stream.mp3, api: /api/*)`);
  } else if (target.env === 'prod-byo') {
    muted('→ web :7700   controller :7701   stream :7702/stream.mp3');
    muted('  point your reverse proxy at those ports — see docker/Caddyfile for the route table.');
  } else {
    muted('→ controller: http://localhost:7701    stream: http://localhost:7702/stream.mp3');
    if (webDevState === 'running') {
      muted('  web (dev): http://localhost:7700  (log: state/logs/web-dev.log)');
    } else {
      muted('  web dev server (separate): `npm --prefix web run dev`  on http://localhost:7700');
    }
  }

  // If the controller reports the operator hasn't finished configuration
  // yet, surface the two paths prominently. Without this, fresh installs
  // see the "stack ready" URL and miss that no music will actually play
  // until Navidrome + LLM are connected. Skipped silently once setup is
  // done, so returning operators don't get nagged on every start.
  const needsSetup = healthy ? await checkNeedsSetup(target.env) : null;
  if (needsSetup === true) {
    console.log();
    header('Finish setup');
    muted('The stack is running but not configured yet — no music plays until');
    muted('Navidrome + your LLM are connected. Pick either path:');
    console.log();
    info(`Terminal:  ${pc.bold('subwave setup')}`);
    info(`Browser:   ${pc.bold(`${webBaseFor(target.env)}/onboarding`)}`);
  }

  await pauseForEnter();
}

// Resolve the env to start, silently. Cascade:
//   1. Explicit positional arg (`subwave start dev|prod|prod-byo`).
//   2. cli.json:preferredEnv — set either by `init` at install time or by
//      the previous `start` invocation (see save block above).
//   3. Filesystem heuristic — clones map to dev, single-prod-file installs
//      map to that prod variant. See inferEnvFromFilesystem().
// If none of the three decide, we error out with a clear pointer rather
// than falling back to an interactive prompt — that branch is effectively
// unreachable in practice (init writes preferredEnv, clones hit step 3).
function resolveEnv(arg?: StartableEnv): ComposeFile | null {
  // 1. Explicit arg wins.
  if (arg) {
    const match = getComposeFiles().find((f) => f.env === arg);
    if (!match) {
      err(`unknown env: ${arg}`);
      return null;
    }
    return match;
  }

  // 2. Persisted preference.
  const cfg = loadConfig();
  if (cfg.preferredEnv) {
    const match = getComposeFiles().find((f) => f.env === cfg.preferredEnv);
    if (match) return match;
  }

  // 3. Filesystem heuristic.
  const inferred = inferEnvFromFilesystem();
  if (inferred) {
    const match = getComposeFiles().find((f) => f.env === inferred);
    if (match) return match;
  }

  err('could not resolve env from install state');
  muted('→ pass `subwave start dev|prod|prod-byo` explicitly, or run `subwave init` to scaffold a fresh install.');
  return null;
}

// When a stack is already up, flag if its image tags don't match the version
// this install expects (process.env.SUBWAVE_VERSION → root .env → 'latest').
// Catches a stale or different-version stack — e.g. a leftover `:pocket`
// build — silently occupying the container names a fresh install reuses, so
// the operator doesn't mistake it for their new install (see the v0.1.30
// install where a 44-min-old `:pocket` stack masked a fresh scaffold).
function warnIfVersionMismatch(file: ComposeFile | null): void {
  if (!file) return;
  let expected = process.env.SUBWAVE_VERSION?.trim();
  if (!expected) {
    try { expected = parseEnvFile(getRootEnv()).SUBWAVE_VERSION?.trim(); } catch { /* no .env yet */ }
  }
  expected = expected || 'latest';

  const tags = new Set(
    runningImageRefs(file)
      .filter((r) => r.includes('subwave-'))
      .map((r) => r.slice(r.lastIndexOf(':') + 1))
      .filter(Boolean),
  );
  const mismatched = [...tags].filter((t) => t !== expected);
  if (mismatched.length === 0) return;

  warn(`running images are tagged ${[...tags].map((t) => `:${t}`).join(', ')}, but this install expects :${expected}.`);
  muted('  Looks like a stale or different-version stack. To replace it:');
  muted('    subwave stop   (then)   subwave start');
}
