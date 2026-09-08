// `subwave self-update` — re-execs the install script rather than duplicating
// download / arch-detect / sudo-fallback. The swap is atomic, so this process
// runs to completion and only the next invocation is the new code.

import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { banner, header, ok, err, info, muted, pauseForEnter } from '../ui.ts';

const INSTALLER_URL = process.env.SUBWAVE_INSTALLER_URL ?? 'https://cli.getsubwave.com';

export async function runSelfUpdateCommand(args: { version?: string } = {}): Promise<void> {
  banner('self-update');

  // For a bun-compiled standalone, execPath IS the subwave binary; under tsx
  // it's the node interpreter, meaning a contributor who wants `git pull`.
  const exe = process.execPath;
  if (exe.endsWith('/node') || exe.endsWith('/bun') || exe.endsWith('/tsx')) {
    err('Refusing to self-update a non-standalone CLI.');
    muted(`process.execPath = ${exe}`);
    muted('You\'re running the CLI from source (tsx/node) — `git pull` the repo instead.');
    process.exit(2);
  }

  // Override the installer's /usr/local/bin default so an ~/.local/bin install
  // stays put; realpathSync keeps a symlinked binary from landing in two places.
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

  // bash -c keeps the pipe inside one shell process, which is the only way
  // `sh -s -- --dir` reaches the install script.
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

// Safe for arbitrary content: every character passes verbatim inside the single
// quotes or comes through as a quoted escape.
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
