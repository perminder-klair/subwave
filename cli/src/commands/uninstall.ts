// `subwave uninstall` — the inverse of `init` + `start`. The bare command keeps
// state/ and only `--purge` takes it; destructive steps confirm unless `--yes`.
// A clone-mode home is only brought down, never deleted (it's the source tree).

import { existsSync, readdirSync, rmSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { resolveSubwaveHome, isCloneMode, HOME_CONFIG_PATH } from '../home.ts';
import { configPath } from '../config.ts';
import { detectCompose, getComposeFiles, isProdEnv, type ComposeFile } from '../compose.ts';
import { composeDownFull } from '../docker.ts';
import { banner, header, ok, warn, err, info, muted, p, pc, exitIfCancelled } from '../ui.ts';

export interface UninstallOptions {
  yes?: boolean;
  purge?: boolean;
  images?: boolean;
  binary?: boolean;
}

// Keep in lockstep with init.ts:scaffold(). state/ is absent on purpose: a
// default uninstall never takes it.
const GENERATED_FILES = [
  'docker-compose.yml',
  'docker-compose.byo.yml',
  'docker-compose.tts-heavy-gpu.yml',
  'docker-compose.analyzer-gpu.yml',
  '.env',
  '.env.example',
];

export async function runUninstallCommand(opts: UninstallOptions = {}): Promise<void> {
  banner('uninstall');

  const resolved = resolveSubwaveHome();
  const home = resolved?.home ?? null;
  const clone = home ? isCloneMode(home) : false;

  // Prefer the file Docker says is running, else the first one present.
  let target: ComposeFile | null = null;
  let runningEnv = 'down';
  if (home) {
    const status = detectCompose();
    runningEnv = status.env;
    target = status.file ?? getComposeFiles().find((f) => existsSync(f.abs)) ?? null;
  }

  const haveConfig = existsSync(HOME_CONFIG_PATH) || existsSync(configPath());
  if (!home && !haveConfig) {
    header('Nothing to uninstall');
    info('No SUB/WAVE install found (no home, no CLI config).');
    return;
  }

  header('This will');
  if (target) {
    muted(`• docker compose down${opts.purge ? ' -v' : ''}${opts.images ? ' --rmi all' : ''}` +
      `  (${runningEnv === 'down' ? 'stack not running' : `${runningEnv} stack`})`);
  } else {
    muted('• (no compose file found to bring down)');
  }
  if (clone) {
    muted(`• ${pc.dim('clone-mode home — leaving source files untouched')} (${home})`);
  } else if (opts.purge && home) {
    muted(`• ${pc.red('remove the entire install dir')} ${home} ${pc.red('(incl. state/ — settings, secrets, jingles, tags)')}`);
  } else if (home) {
    muted(`• remove compose files + .env from ${home} ${pc.dim('(keeps state/)')}`);
  }
  muted('• remove CLI config (~/.config/subwave)');
  if (opts.binary) muted(`• remove the subwave binary (${binaryPath() ?? 'n/a'})`);
  console.log();

  if (!opts.yes) {
    const yes = exitIfCancelled(await p.confirm({
      message: opts.purge
        ? `${pc.red('Purge')} this SUB/WAVE install — including all state — permanently?`
        : (isProdEnv(runningEnv as never)
          ? 'Uninstall SUB/WAVE? Listeners will hear silence.'
          : 'Uninstall SUB/WAVE?'),
      initialValue: false,
    }), { backOnCancel: false });
    if (!yes) {
      muted('cancelled — nothing changed.');
      return;
    }
  }

  header('Uninstalling');

  if (target) {
    muted(`docker compose -f ${target.file} down${opts.purge ? ' -v' : ''}${opts.images ? ' --rmi all' : ''}`);
    const code = await composeDownFull(target, { volumes: opts.purge, rmi: opts.images });
    if (code !== 0) warn(`docker compose exited ${code} — continuing with file cleanup`);
    else ok('stack down');
  }

  if (home && !clone) {
    if (opts.purge) {
      try {
        rmSync(home, { recursive: true, force: true });
        ok(`removed install dir ${home}`);
      } catch (e) {
        err(`could not remove ${home}: ${(e as Error).message}`);
      }
    } else {
      for (const f of GENERATED_FILES) {
        const p2 = resolve(home, f);
        if (existsSync(p2)) rmSync(p2, { force: true });
      }
      // Sweep any `docker-compose*.bak-*` backups `subwave sync` left behind.
      for (const f of readdirSync(home)) {
        if (/^docker-compose.*\.bak-/.test(f)) rmSync(resolve(home, f), { force: true });
      }
      ok(`removed compose files + .env (kept ${resolve(home, 'state')})`);
    }
  } else if (clone) {
    info('clone-mode home — left your source checkout untouched.');
  }

  for (const cfg of [HOME_CONFIG_PATH, configPath()]) {
    if (existsSync(cfg)) rmSync(cfg, { force: true });
  }
  ok('removed CLI config');

  if (opts.binary) removeBinary();

  console.log();
  if (!opts.purge && home && !clone) {
    muted(`State preserved at ${resolve(home, 'state')} — reinstall with \`subwave init\` to reuse it, or remove it manually.`);
  } else {
    muted('Done. To reinstall: curl -fsSL https://cli.getsubwave.com | sh');
  }
}

// null when running from source, where there's no binary to delete.
function binaryPath(): string | null {
  const p2 = process.execPath;
  const base = basename(p2).toLowerCase();
  if (base.startsWith('node') || base.startsWith('bun') || base.startsWith('tsx') || p2.includes('node_modules')) {
    return null;
  }
  return p2;
}

function removeBinary(): void {
  const p2 = binaryPath();
  if (!p2) {
    muted('skipped --binary: running from source, not a compiled binary.');
    return;
  }
  try {
    rmSync(p2, { force: true });
    ok(`removed binary ${p2}`);
  } catch (e) {
    // Almost always EACCES — installed under /usr/local/bin via sudo.
    warn(`couldn't remove ${p2}: ${(e as Error).message}`);
    muted(`  remove it yourself: sudo rm ${p2}`);
  }
}
