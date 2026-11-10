// `subwave restart [service]` — the rebuild-vs-restart split from CLAUDE.md. The
// controller COPYs its source at build time, so it always needs a rebuild;
// broadcast bind-mounts radio.liq in dev but bakes it in prod, so only prod does.

import { detectCompose, listDeclaredServices, type ComposeFile, type ComposeEnv } from '../compose.ts';
import { composeRestart, composeUpBuild, composeUpRecreate } from '../docker.ts';
import { isCloneMode } from '../home.ts';
import { getSubwaveHome } from '../util.ts';
import { exitIfCancelled, ok, err, info, muted, p, pc, pauseForEnter, header } from '../ui.ts';
import { maybeStartWebDev, stopWebDev } from '../web-dev.ts';

// Sentinels, not compose services. WEB_DEV_SERVICE doubles as its picker label.
const WEB_DEV_SERVICE = 'web (dev)';
const ALL_SERVICES = '__all__';

interface ServicePolicy {
  rebuild: boolean;
  hint: string;
}

// Anything absent from this map gets a plain restart.
const POLICY: Record<string, ServicePolicy> = {
  controller: { rebuild: true,  hint: 'rebuild — source is COPY-d at build time' },
  broadcast:  { rebuild: false, hint: 'restart — radio.liq is bind-mounted in dev' },
  web:        { rebuild: false, hint: 'restart (rebuild needed only after Dockerfile / build edits)' },
  caddy:      { rebuild: false, hint: 'restart' },
};

export interface RestartOpts {
  service?: string;
  forceBuild?: boolean;
}

export async function runRestartCommand(opts: RestartOpts = {}): Promise<void> {
  const current = detectCompose();
  if (current.env === 'down' || !current.file) {
    header('Nothing to restart');
    info('stack is down — run `subwave start` first.');
    await pauseForEnter();
    return;
  }

  const service = opts.service ?? (await pickService(current.file, current.env));
  if (!service) return;

  // `--force-recreate` because a plain `up -d` quietly no-ops services whose
  // config hasn't changed, which isn't what anyone means by "restart".
  if (service === ALL_SERVICES) {
    header('Restarting full stack');
    muted(`docker compose -f ${current.file.file} up -d --force-recreate`);
    console.log();
    const code = await composeUpRecreate(current.file);
    if (code !== 0) err(`docker compose exited ${code}`);
    else ok('full stack recreated.');
    await pauseForEnter();
    return;
  }

  // No docker involved at all here.
  if (service === WEB_DEV_SERVICE || service === 'web-dev') {
    if (current.env !== 'dev') {
      err('`web (dev)` only applies to the dev stack — in prod, restart `web` (the compose service).');
      await pauseForEnter();
      return;
    }
    header('Restarting web dev server');
    const stopResult = stopWebDev();
    if (stopResult.stopped) {
      muted('killed prior next dev');
    } else if (stopResult.reason && stopResult.reason !== 'not running') {
      muted(`stop: ${stopResult.reason}`);
    }
    const state = await maybeStartWebDev({ askFirst: false });
    if (state === 'running') ok('web dev restarted.');
    else err('web dev not running after restart.');
    await pauseForEnter();
    return;
  }

  const policy = POLICY[service] ?? { rebuild: false, hint: 'restart' };
  // A standalone install has no source to build from, so a wanted rebuild
  // degrades to recreate rather than erroring.
  const cloneMode = isCloneMode(getSubwaveHome());
  const wantsBuild = opts.forceBuild || policy.rebuild;
  const action: 'build' | 'recreate' | 'restart' =
    wantsBuild && cloneMode  ? 'build' :
    wantsBuild && !cloneMode ? 'recreate' :
                               'restart';

  const verb = action === 'build' ? 'Rebuilding' : action === 'recreate' ? 'Recreating' : 'Restarting';
  header(`${verb} ${service}`);
  muted(
    action === 'build'    ? `docker compose -f ${current.file.file} up -d --build ${service}` :
    action === 'recreate' ? `docker compose -f ${current.file.file} up -d --force-recreate ${service}` :
                            `docker compose -f ${current.file.file} restart ${service}`
  );
  if (wantsBuild && !cloneMode) {
    muted('(standalone install — no source to rebuild from; recreating to re-read .env instead)');
  }
  console.log();

  const code =
    action === 'build'    ? await composeUpBuild(current.file, service) :
    action === 'recreate' ? await composeUpRecreate(current.file, service) :
                            await composeRestart(current.file, service);

  if (code !== 0) {
    err(`docker compose exited ${code}`);
  } else {
    const past = action === 'build' ? 'rebuilt + recreated' : action === 'recreate' ? 'recreated' : 'restarted';
    ok(`${service} ${past}.`);
  }
  await pauseForEnter();
}

async function pickService(file: ComposeFile, env: ComposeEnv): Promise<string | null> {
  const declared = listDeclaredServices(file);
  if (declared.length === 0) {
    err('could not list services from compose.');
    return null;
  }
  const options = declared.map((svc) => {
    const policy = POLICY[svc] ?? { rebuild: false, hint: 'restart' };
    return {
      value: svc,
      label: svc + (policy.rebuild ? pc.dim('  [rebuild]') : ''),
      hint: policy.hint,
    };
  });
  // The dev web server isn't a compose service, so add it by hand.
  if (env === 'dev') {
    options.push({
      value: WEB_DEV_SERVICE,
      label: WEB_DEV_SERVICE,
      hint: 'kill + respawn `npm run dev` on :7700',
    });
  }
  // Last, so the per-service rows stay the visual default.
  options.push({
    value: ALL_SERVICES,
    label: pc.bold('all services'),
    hint: 'force-recreate every container — picks up .env changes',
  });
  const chosen = exitIfCancelled(await p.select<string>({
    message: 'Which service?',
    options,
  }));
  return chosen;
}
