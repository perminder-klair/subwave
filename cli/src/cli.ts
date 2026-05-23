// SUB/WAVE operator CLI entry point. Parses argv, dispatches to a
// command, or falls back to the interactive menu when no command is
// given. First-run detection — if controller/.env doesn't exist, run
// `setup` regardless of the argument.

import { existsSync } from 'node:fs';
import { CONTROLLER_ENV } from './util.ts';
import { runSetupCommand } from './commands/setup.ts';

const HELP = `
SUB/WAVE — operator CLI

Usage:
  subwave                  open the interactive menu (default)
  subwave setup            (re-)run the install wizard
  subwave status           quick stack + now-playing snapshot
  subwave doctor           full diagnostic sweep
  subwave start [dev|prod] docker compose up -d (dev also starts web \`npm run dev\`)
  subwave stop             docker compose down (also kills web dev in dev mode)
  subwave restart [svc]    rebuild / restart a service (dev adds \`web-dev\`)
  subwave logs [svc|all]   tail docker compose logs (dev adds \`web-dev\`)
  subwave play [dev|prod]  open the terminal player (TUI)
  subwave listen [dev|prod] open the web player in a browser
  subwave admin [dev|prod] open the admin console in a browser

  subwave help             show this message
  subwave --version        print version

Esc inside the menu navigates back. Ctrl-C exits.
`.trimStart();

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP);
    return;
  }
  if (cmd === '--version' || cmd === '-v') {
    // Read package.json next to this file's directory at runtime so the
    // version stays accurate without a build step.
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = resolve(fileURLToPath(import.meta.url), '..', '..');
    try {
      const pkg = JSON.parse(readFileSync(resolve(here, 'package.json'), 'utf8'));
      process.stdout.write(`${pkg.version}\n`);
    } catch {
      process.stdout.write('unknown\n');
    }
    return;
  }

  // First-run: if there's no controller/.env we can't do anything else
  // meaningful, so push the operator into setup. Exception: `help` / version
  // checked above, and explicit `setup` falls through naturally.
  if (!existsSync(CONTROLLER_ENV) && cmd !== 'setup') {
    process.stderr.write('No controller/.env found — running setup wizard first.\n\n');
    await runSetupCommand();
    return;
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
