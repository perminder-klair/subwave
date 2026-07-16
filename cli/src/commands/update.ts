// `subwave update` — refresh the running stack to the latest published
// images (or, in clone mode, the latest source).
//
// Two flavours collapse into one command:
//   - Image-first install (standalone CLI / no clone): pull fresh
//     ghcr.io/perminder-klair/subwave-* images, recreate any service whose
//     image actually changed. No build — the binary on PATH already has
//     the latest compose file thanks to `subwave self-update`.
//   - Clone install: git pull + rebuild local images for services whose
//     source changed, then recreate. Mirrors scripts/update.sh.
//
// `subwave self-update` is a separate concern — it replaces the CLI
// binary itself, not the docker images.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { detectCompose } from '../compose.ts';
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

  // 1. (clone only) git pull. Standalone installs don't have a checkout.
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

  // 1b. (standalone only) Move the SUBWAVE_VERSION pin to this CLI's version
  // before pulling, so a binary that was just `self-update`d pulls the images
  // matching its frozen compose files instead of whatever the old pin named.
  // Clone installs track git, not image tags — leave their .env alone.
  if (!cloneMode) moveVersionPin(home);

  // 2. docker compose pull — refresh base images. --ignore-buildable lets
  // it skip services with only a `build:` block (only matters in dev).
  header('docker compose pull');
  const pullArgs = ['compose', '-f', compose.file.file, 'pull'];
  if (cloneMode) pullArgs.push('--ignore-buildable');
  const pullCode = await run('docker', pullArgs, home);
  if (pullCode !== 0) {
    warn(`docker compose pull exited ${pullCode} — continuing anyway.`);
  }

  // 3. (clone only) rebuild local images. Standalone installs use the
  // pulled GHCR images directly; nothing to build locally.
  if (cloneMode) {
    header('docker compose build');
    const buildCode = await run(
      'docker',
      ['compose', '-f', compose.file.file, 'build', '--pull'],
      home,
    );
    if (buildCode !== 0) {
      err(`docker compose build exited ${buildCode}`);
      await pauseForEnter();
      return;
    }
  }

  // 4. Recreate. `up -d --remove-orphans` recreates only services whose
  // image / config actually changed; listeners on /stream.mp3 only hiccup
  // if the broadcast container restarts (rare on a pure image bump).
  header('docker compose up -d');
  const upCode = await run(
    'docker',
    ['compose', '-f', compose.file.file, 'up', '-d', '--remove-orphans'],
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

  // Compose topology (new services, changed env wiring) doesn't ride an image
  // bump — only `subwave sync` re-materialises it. Flag drift so an install
  // scaffolded before a service was added (e.g. the analyzer sidecar) doesn't
  // silently stay behind. See #1043. Clone installs track git, not the binary.
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

// Move an existing SUBWAVE_VERSION version pin in the install's .env up to this
// CLI's version. No-op (silent) when: the CLI is a dev build (no published tag
// to pin to), there's no .env, or there's no concrete version pin to move
// (fresh pre-pin installs stay on :latest — no surprises). Edits only the pin
// line, preserving the rest of the file byte-for-byte.
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
