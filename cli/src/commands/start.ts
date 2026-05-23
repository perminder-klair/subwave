// `subwave start [dev|prod]` — bring the stack up.
//
// Behaviour:
//   - If a stack is already running, refuse (use `subwave restart` / `stop` instead).
//   - If the arg is given, use it; otherwise prompt dev vs prod (with the
//     last choice remembered in CLI config).
//   - Shell out to `docker compose up -d` (prod also builds, matching the
//     existing setup.mjs behaviour).
//   - Poll /health for up to 30 s and report when the stream comes on-air.

import { COMPOSE_FILES, detectCompose, isProdEnv, type ComposeEnv, type ComposeFile } from '../compose.ts';
import { composeUp } from '../docker.ts';
import { waitForHealth } from '../api.ts';
import { loadConfig, saveConfig } from '../config.ts';
import { exitIfCancelled, ok, warn, err, info, muted, p, pc, pauseForEnter, header } from '../ui.ts';
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
    muted('→ use `subwave restart` to bounce a service, or `subwave stop` first.');
    await pauseForEnter();
    return;
  }

  const target = await pickEnv(opts.envArg);
  if (!target) return;

  // Remember the operator's choice so future no-arg invocations default to it.
  const cfg = loadConfig();
  if (cfg.preferredEnv !== target.env) {
    cfg.preferredEnv = target.env;
    saveConfig(cfg);
  }

  // Prod-style modes build their first-party images locally on the way up;
  // dev never does (it pulls fully-built upstream images plus a host-side
  // npm run dev for the web UI).
  const wantBuild = isProdEnv(target.env);
  header(`Starting ${target.env} stack`);
  muted(`docker compose -f ${target.file} up -d${wantBuild ? ' --build' : ''}`);
  console.log();

  const code = await composeUp(target, { build: wantBuild });
  console.log();
  if (code !== 0) {
    err(`docker compose exited ${code}`);
    muted('→ `subwave logs <service>` to inspect.');
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
    muted('→ http://localhost:4800   (stream: /stream.mp3, api: /api/*)');
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

  await pauseForEnter();
}

async function pickEnv(arg?: StartableEnv): Promise<ComposeFile | null> {
  // Honour the explicit arg first.
  if (arg) {
    const match = COMPOSE_FILES.find((f) => f.env === arg);
    if (!match) {
      err(`unknown env: ${arg}`);
      return null;
    }
    return match;
  }

  const cfg = loadConfig();
  const choice = exitIfCancelled(await p.select<StartableEnv>({
    message: 'Which environment?',
    initialValue: cfg.preferredEnv ?? 'dev',
    options: [
      {
        value: 'dev',
        label: 'dev',
        hint: 'docker-compose.yml · controller :7701 · web dev separately on :7700',
      },
      {
        value: 'prod',
        label: 'prod',
        hint: 'docker-compose.prod.yml · Caddy on :4800 · web baked into image',
      },
      {
        value: 'prod-byo',
        label: 'prod (BYO proxy)',
        hint: 'docker-compose.byo-proxy.yml · web :7700 · controller :7701 · icecast :7702',
      },
    ],
  }));
  return COMPOSE_FILES.find((f) => f.env === choice) ?? null;
}
