// SUB/WAVE operator CLI entry point. Parses argv, dispatches to a
// command, or falls back to the interactive menu when no command is
// given.
//
// Boot order matters:
//   1. Strip `--home <path>` from argv and stash it on SUBWAVE_HOME so the
//      lazy resolver in util.ts picks it up.
//   2. Handle commands that DON'T need a resolved home (--version, help,
//      init) — these short-circuit before any path lookup.
//   3. Everything else either has a resolvable home or gets pointed at
//      `subwave init` by requireSubwaveHome().

import { existsSync } from 'node:fs';
import { consumeHomeFlag, resolveSubwaveHome } from './home.ts';
import { getRootEnv, getLegacyControllerEnv } from './util.ts';
import { runSetupCommand } from './commands/setup.ts';

const HELP = `
SUB/WAVE — operator CLI

Usage:
  subwave                  open the interactive menu (default)
  subwave init             scaffold a fresh install at ~/subwave (no-clone path)
  subwave setup            (re-)run the install wizard
  subwave status           quick stack + now-playing snapshot
  subwave doctor           full diagnostic sweep
  subwave start [dev|prod] docker compose up -d (dev also starts web \`npm run dev\`)
  subwave stop             docker compose down (also kills web dev in dev mode)
  subwave restart [svc]    rebuild / restart a service (dev adds \`web-dev\`)
  subwave logs [svc|all]   tail docker compose logs (dev adds \`web-dev\`)
  subwave update           pull new images + recreate changed services
  subwave play [dev|prod]  open the terminal player (TUI; auto-fetched on first run)
  subwave listen [dev|prod] open the web player in a browser
  subwave admin [dev|prod] open the admin console in a browser
  subwave self-update      replace the installed binary with the latest release

Flags:
  --home <path>            override SUBWAVE_HOME for this invocation

  subwave help             show this message
  subwave --version        print version

Esc inside the menu navigates back. Ctrl-C exits.
`.trimStart();

async function main(): Promise<void> {
  // Mutates process.argv in place, removing --home/--home=<path>.
  const homeFlag = consumeHomeFlag(process.argv);
  if (homeFlag) process.env.SUBWAVE_HOME = homeFlag;

  const [, , cmd, ...rest] = process.argv;

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP);
    return;
  }
  if (cmd === '--version' || cmd === '-v') {
    // Embedded at build time by cli/scripts/embed-assets.ts (release-please
    // bumps cli/package.json in lockstep with the git tag, so this stays
    // accurate across releases). Doesn't touch SUBWAVE_HOME.
    const { CLI_VERSION } = await import('./assets.ts');
    process.stdout.write(`${CLI_VERSION}\n`);
    return;
  }
  if (cmd === 'init') {
    const { runInitCommand } = await import('./commands/init.ts');
    await runInitCommand();
    return;
  }
  if (cmd === 'self-update') {
    const { runSelfUpdateCommand } = await import('./commands/self-update.ts');
    // --version <tag> picks a specific release; otherwise latest.
    const versionFlagIdx = rest.findIndex((a) => a === '--version' || a.startsWith('--version='));
    let version: string | undefined;
    if (versionFlagIdx >= 0) {
      const a = rest[versionFlagIdx] as string;
      version = a.startsWith('--version=') ? a.slice('--version='.length) : rest[versionFlagIdx + 1];
    }
    await runSelfUpdateCommand({ version });
    return;
  }

  // From here on we need a resolved home. Two failure modes worth distinct
  // messages:
  //   - No home resolvable at all → point at `subwave init` (fresh install).
  //   - Home exists but has no .env → push into the wizard (`subwave setup`).
  // The util.ts lazy paths will call requireSubwaveHome() on first access; we
  // pre-check here to give a nicer message before that happens.
  const resolved = resolveSubwaveHome();
  if (!resolved) {
    process.stderr.write(
      'No SUB/WAVE install found.\n\n' +
      'Run `subwave init` to scaffold a fresh install at ~/subwave,\n' +
      'or pass --home <path> to point at an existing one.\n',
    );
    process.exit(2);
  }

  // First-run inside an existing install: no .env yet. The legacy
  // controller/.env is checked too so a partial upgrade doesn't fall back
  // into the init error unnecessarily. `init` itself is exempt — it's the
  // command that creates .env. Everything else bails with a pointer.
  const haveEnv = existsSync(getRootEnv()) || existsSync(getLegacyControllerEnv());
  if (!haveEnv && cmd !== 'init') {
    process.stderr.write(
      `No .env found at ${resolved.home}.\n\n` +
      'Run `subwave init` to scaffold the install (compose files + admin creds + .env),\n' +
      'then re-run this command.\n',
    );
    process.exit(2);
  }

  switch (cmd) {
    case undefined: {
      const { runMenu } = await import('./menu.ts');
      await runMenu();
      return;
    }
    case 'setup': {
      await runSetupCommand();
      return;
    }
    case 'status': {
      const { runStatusCommand } = await import('./commands/status.ts');
      await runStatusCommand();
      return;
    }
    case 'doctor': {
      const { runDoctorCommand } = await import('./commands/doctor.ts');
      await runDoctorCommand();
      return;
    }
    case 'start': {
      const { runStartCommand } = await import('./commands/start.ts');
      const envArg = rest[0];
      if (envArg && envArg !== 'dev' && envArg !== 'prod' && envArg !== 'prod-byo') {
        process.stderr.write(`Unknown env: ${envArg}. Expected 'dev', 'prod', or 'prod-byo'.\n`);
        process.exit(2);
      }
      await runStartCommand({ envArg: envArg as 'dev' | 'prod' | 'prod-byo' | undefined });
      return;
    }
    case 'stop': {
      const { runStopCommand } = await import('./commands/stop.ts');
      await runStopCommand();
      return;
    }
    case 'restart': {
      const { runRestartCommand } = await import('./commands/restart.ts');
      const service = rest[0];
      const forceBuild = rest.includes('--build');
      await runRestartCommand({ service, forceBuild });
      return;
    }
    case 'logs': {
      const { runLogsCommand } = await import('./commands/logs.ts');
      const service = rest[0];
      await runLogsCommand({ service });
      return;
    }
    case 'update': {
      const { runUpdateCommand } = await import('./commands/update.ts');
      await runUpdateCommand();
      return;
    }
    case 'play': {
      const { runPlayCommand } = await import('./commands/play.ts');
      const envArg = rest[0];
      if (envArg && envArg !== 'dev' && envArg !== 'prod' && envArg !== 'prod-byo') {
        process.stderr.write(`Unknown env: ${envArg}. Expected 'dev', 'prod', or 'prod-byo'.\n`);
        process.exit(2);
      }
      await runPlayCommand({ envArg: envArg as 'dev' | 'prod' | 'prod-byo' | undefined });
      return;
    }
    case 'listen':
    case 'admin': {
      const { runOpenWebCommand } = await import('./commands/open-web.ts');
      const envArg = rest[0];
      if (envArg && envArg !== 'dev' && envArg !== 'prod' && envArg !== 'prod-byo') {
        process.stderr.write(`Unknown env: ${envArg}. Expected 'dev', 'prod', or 'prod-byo'.\n`);
        process.exit(2);
      }
      await runOpenWebCommand(cmd, { envArg: envArg as 'dev' | 'prod' | 'prod-byo' | undefined });
      return;
    }
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
