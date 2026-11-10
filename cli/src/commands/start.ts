// `subwave start [dev|prod|prod-byo]` — bring the stack up. The target env is
// resolved silently rather than prompted for; see resolveEnv().

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

  // Future no-arg invocations default to this.
  const cfg = loadConfig();
  if (cfg.preferredEnv !== target.env) {
    cfg.preferredEnv = target.env;
    saveConfig(cfg);
  }

  // Dev has no `image:` on the controller, so it builds locally. The prods use
  // published GHCR images; `--pull always` stops a stale local tag masking them.
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
    // A user not in the `docker` group gets EACCES on docker.sock (#156).
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

  // Generous: the controller takes a few seconds to reach Icecast on cold boot.
  const sp = p.spinner();
  sp.start('Waiting for controller to report on-air…');
  const healthy = await waitForHealth(target.env, 30_000, (ms) => {
    sp.message(`Waiting… ${Math.floor(ms / 1000)}s`);
  });
  sp.stop(healthy ? 'Controller on-air' : pc.yellow('Controller not on-air after 30s — continuing'));

  if (healthy) ok('stack ready');
  else warn('stack started but /health is not yet returning on-air');

  // In dev the web UI is a host-side `npm run dev`, not a compose service —
  // start it here so the operator doesn't need a second command.
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

  // Otherwise a fresh install reads "stack ready" and misses that nothing plays
  // until Navidrome + LLM are connected. Silent once setup is done.
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

// Explicit arg → persisted preferredEnv → filesystem heuristic. An undecidable
// install errors out rather than prompting.
function resolveEnv(arg?: StartableEnv): ComposeFile | null {
  if (arg) {
    const match = getComposeFiles().find((f) => f.env === arg);
    if (!match) {
      err(`unknown env: ${arg}`);
      return null;
    }
    return match;
  }

  const cfg = loadConfig();
  if (cfg.preferredEnv) {
    const match = getComposeFiles().find((f) => f.env === cfg.preferredEnv);
    if (match) return match;
  }

  const inferred = inferEnvFromFilesystem();
  if (inferred) {
    const match = getComposeFiles().find((f) => f.env === inferred);
    if (match) return match;
  }

  err('could not resolve env from install state');
  muted('→ pass `subwave start dev|prod|prod-byo` explicitly, or run `subwave init` to scaffold a fresh install.');
  return null;
}

// Catches an old stack occupying the container names a fresh install reuses.
// Expected version: env → root .env → 'latest'.
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
