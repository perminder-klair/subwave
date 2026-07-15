// `subwave self-update` — re-runs the install script to fetch the latest
// release binary in place. Equivalent to:
//
//   curl -fsSL https://cli.getsubwave.com | sh -s -- --dir <current install dir>
//
// We re-exec the installer instead of duplicating its logic here so the
// download / arch-detect / sudo-fallback path stays in exactly one place.
// The installer overwrites the binary atomically (mv after chmod), so the
// running process keeps executing — only the next invocation picks up the
// new code.

import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { banner, header, ok, err, info, muted, pauseForEnter } from '../ui.ts';

const INSTALLER_URL = process.env.SUBWAVE_INSTALLER_URL ?? 'https://cli.getsubwave.com';

export async function runSelfUpdateCommand(args: { version?: string } = {}): Promise<void> {
  banner('self-update');

  // Resolve where this binary lives. process.execPath is the running
  // executable; for a bun-compiled standalone, that's the subwave binary
  // itself. For tsx-loaded dev runs, it's the node interpreter — we treat
  // that as "you're a contributor, just `git pull` instead."
  const exe = process.execPath;
  if (exe.endsWith('/node') || exe.endsWith('/bun') || exe.endsWith('/tsx')) {
    err('Refusing to self-update a non-standalone CLI.');
    muted(`process.execPath = ${exe}`);
    muted('You\'re running the CLI from source (tsx/node) — `git pull` the repo instead.');
    process.exit(2);
  }

  // Where to put the new binary. The installer's default is /usr/local/bin;
  // we override with the dir of the current executable so an `~/.local/bin`
  // install stays put. realpathSync resolves symlinks so a symlinked binary
  // (e.g. via Homebrew) doesn't end up in two places.
  let installDir: string;
  try {
    installDir = dirname(realpathSync(exe));
  } catch {
    installDir = dirname(exe);
  }

  header('Fetching installer + replacing binary');
  info(`current: ${exe}`);
  info(`dest:    ${installDir}/subwave`);
  muted(`source:  ${INSTALLER_URL}`);
  console.log();

  // Pipe curl through sh with --dir set to the resolved install dir. We
  // shell out to bash -c so the pipe lives inside a single shell process,
  // which is the only way --dir gets passed to the install script (sh -s
  // forwards everything after `--` to the script).
  const versionArg = args.version ? ` --version ${shellEscape(args.version)}` : '';
  const cmd = `set -e; curl -fsSL ${shellEscape(INSTALLER_URL)} | sh -s -- --dir ${shellEscape(installDir)}${versionArg}`;
  await new Promise<void>((resolveP) => {
    const child = spawn('bash', ['-c', cmd], { stdio: 'inherit' });
    child.on('exit', (code) => {
      if (code === 0) ok('self-update complete');
      else err(`installer exited ${code}`);
      resolveP();
    });
  });

  console.log();
  muted('The running process is still the old binary — next invocation picks up the new one.');
  muted('Then run `subwave sync` if your compose files are behind the new binary, and `subwave update`.');
  await pauseForEnter();
}

// Single-quote the argument and escape any single quotes inside it. Safe
// against arbitrary content because every character either gets through
// verbatim (inside the single quotes) or as a quoted escape sequence.
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
