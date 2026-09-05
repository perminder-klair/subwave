// `subwave update` — refresh the running stack. Two shapes behind one command:
// a standalone install pulls fresh GHCR images and never builds (its compose
// files came in with the binary), while a clone git-pulls and rebuilds locally,
// mirroring scripts/update.sh. Replacing the CLI binary itself is a separate
// command, `subwave self-update`.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { detectCompose } from '../compose.ts';
import { composeFileArgs } from '../docker.ts';
import { resolveInstallMode, detectDrift, hasDrift } from '../compose-sync.ts';
import { getSubwaveHome } from '../util.ts';
import { isCloneMode } from '../home.ts';
import { cliImageTag, movePinInEnv } from '../version.ts';
import { banner, header, ok, warn, err, info, muted, pauseForEnter } from '../ui.ts';

export async function runUpdateCommand(): Promise<void> {
  banner('update');

  const compose = detectCompose();
  if (compose.env === 'down' || !compose.file) {
    warn('stack is not running.');
    muted('Bring it up first with `subwave start`, then re-run `subwave update`.');
    await pauseForEnter();
    return;
  }

  const home = getSubwaveHome();
  const cloneMode = isCloneMode(home);
  info(`env: ${compose.env}   compose: ${compose.file.file}   home: ${home}`);
  console.log();

  if (cloneMode) {
    header('git pull');
    const pullCode = await run('git', ['pull', '--ff-only'], home);
    if (pullCode !== 0) {
      err(`git pull exited ${pullCode}`);
      muted('Resolve conflicts or detached state, then re-run `subwave update`.');
      await pauseForEnter();
      return;
    }
  }

  // Must happen BEFORE the pull: a binary that was just self-updated has to
  // fetch the images matching its frozen compose files, not whatever the old
  // pin named. Clone installs track git, not image tags — leave their .env be.
  if (!cloneMode) moveVersionPin(home);

  // --ignore-buildable skips services that carry only a `build:` block.
  header('docker compose pull');
  const pullArgs = ['compose', ...composeFileArgs(compose.file), 'pull'];
  if (cloneMode) pullArgs.push('--ignore-buildable');
  const pullCode = await run('docker', pullArgs, home);
  if (pullCode !== 0) {
    warn(`docker compose pull exited ${pullCode} — continuing anyway.`);
  }

  if (cloneMode) {
    header('docker compose build');
    const buildCode = await run(
      'docker',
      ['compose', ...composeFileArgs(compose.file), 'build', '--pull'],
      home,
    );
    if (buildCode !== 0) {
      err(`docker compose build exited ${buildCode}`);
      await pauseForEnter();
      return;
    }
  }

  // Recreates only what actually changed, so listeners hiccup only when the
  // broadcast container itself restarts — rare on a pure image bump.
  header('docker compose up -d');
  const upCode = await run(
    'docker',
    ['compose', ...composeFileArgs(compose.file), 'up', '-d', '--remove-orphans'],
    home,
  );
  if (upCode !== 0) {
    err(`docker compose up exited ${upCode}`);
    await pauseForEnter();
    return;
  }

  console.log();
  ok('update complete');
  muted('  `subwave status` to confirm services are healthy.');
  muted('  `subwave logs <service>` if anything looks off.');
  if (!cloneMode) {
    muted('  `subwave self-update` to refresh the CLI binary itself.');
  }

  // New services and changed env wiring don't ride an image bump — only
  // `subwave sync` re-materialises the compose files, so an install scaffolded
  // before the analyzer sidecar existed would silently stay behind (#1043).
  if (!cloneMode) {
    const mode = resolveInstallMode(home);
    if (mode && hasDrift(detectDrift(home, mode))) {
      console.log();
      warn('your compose files are behind this CLI — new services / settings are missing.');
      muted('  → run `subwave sync` to refresh them (backs up your current files first).');
    }
  }

  await pauseForEnter();
}

// Silently a no-op on a dev build (no published tag), with no .env, or with no
// concrete pin to move — a pre-pin install stays on :latest rather than being
// surprised into a fixed version.
function moveVersionPin(home: string): void {
  const target = cliImageTag();
  if (!target) return;
  const envPath = resolve(home, '.env');
  if (!existsSync(envPath)) return;
  const moved = movePinInEnv(readFileSync(envPath, 'utf8'), target);
  if (!moved) return;
  writeFileSync(envPath, moved.text);
  header('version pin');
  ok(`moved SUBWAVE_VERSION ${moved.from} → ${target} (matches this CLI)`);
  console.log();
}

function run(cmd: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolveP) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit' });
    child.on('exit', (code) => resolveP(code ?? 1));
  });
}
