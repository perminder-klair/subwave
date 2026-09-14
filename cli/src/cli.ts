// CLI entry point: dispatches a command, or opens the interactive menu. Boot
// order is load-bearing: `--home` must reach SUBWAVE_HOME before anything
// triggers util.ts's lazy resolver, and commands that work without an install
// must short-circuit above the resolved-home gate.

import { existsSync } from 'node:fs';
import { consumeHomeFlag, resolveSubwaveHome } from './home.ts';
import { getRootEnv, getLegacyControllerEnv } from './util.ts';
import { runSetupCommand } from './commands/setup.ts';

const HELP = `
SUB/WAVE — operator CLI

Usage:
  subwave                  open the interactive menu (default)
  subwave init             scaffold a fresh install at ~/subwave (no-clone path)
  subwave init --yes       non-interactive scaffold + start with defaults
  subwave setup            (re-)run the install wizard
  subwave status           quick stack + now-playing snapshot
  subwave doctor           full diagnostic sweep
  subwave start [dev|prod] docker compose up -d (dev also starts web \`npm run dev\`)
  subwave stop             docker compose down (also kills web dev in dev mode)
  subwave restart [svc]    rebuild / restart a service (dev adds \`web-dev\`)
  subwave logs [svc|all]   tail docker compose logs (dev adds \`web-dev\`)
  subwave update           pull new images + recreate changed services
  subwave sync             refresh compose files that are behind this CLI (--check to dry-run)
  subwave listen [dev|prod] open the web player in a browser
  subwave admin [dev|prod] open the admin console in a browser
  subwave self-update      replace the installed binary with the latest release
  subwave uninstall        tear down the stack + remove the install (keeps state/)

Flags:
  --home <path>            override SUBWAVE_HOME for this invocation

init flags:
  --yes, -y                skip all prompts; use defaults (immune to the macOS
                           piped-stdin hang — used by the curl|sh installer)
  --no-start               scaffold only; don't bring the stack up
  --mode <prod|prod-byo>   deployment shape (default: prod)
  --admin-user <user>      admin username (default: admin)
  --admin-pass <pass>      admin password (default: randomly generated)
  --site-url <url>         public site URL (default: none)

uninstall flags:
  --purge                  also remove the whole install dir (incl. state/) + volumes
  --images                 also remove the pulled ghcr images
  --binary                 also remove the subwave binary
  --yes, -y                skip the confirmation prompt

  subwave help             show this message
  subwave --version        print version

Esc inside the menu navigates back. Ctrl-C exits.
`.trimStart();

async function main(): Promise<void> {
  const homeFlag = consumeHomeFlag(process.argv);
  if (homeFlag) process.env.SUBWAVE_HOME = homeFlag;

  const [, , cmd, ...rest] = process.argv;

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP);
    return;
  }
  if (cmd === '--version' || cmd === '-v') {
    // Imported lazily so printing a version never resolves SUBWAVE_HOME.
    const { CLI_VERSION } = await import('./assets.ts');
    process.stdout.write(`${CLI_VERSION}\n`);
    return;
  }
  if (cmd === 'init') {
    const { runInitCommand } = await import('./commands/init.ts');
    const flag = (name: string): string | undefined => {
      const i = rest.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
      if (i < 0) return undefined;
      const a = rest[i] as string;
      return a.includes('=') ? a.slice(a.indexOf('=') + 1) : rest[i + 1];
    };
    const mode = flag('mode');
    if (mode && mode !== 'prod' && mode !== 'prod-byo') {
      process.stderr.write(`Unknown --mode: ${mode}. Expected 'prod' or 'prod-byo'.\n`);
      process.exit(2);
    }
    await runInitCommand({
      yes: rest.includes('--yes') || rest.includes('-y'),
      start: rest.includes('--no-start') ? false : undefined,
      mode: mode as 'prod' | 'prod-byo' | undefined,
      adminUser: flag('admin-user'),
      adminPass: flag('admin-pass'),
      siteUrl: flag('site-url'),
    });
    return;
  }
  if (cmd === 'self-update') {
    const { runSelfUpdateCommand } = await import('./commands/self-update.ts');
    const versionFlagIdx = rest.findIndex((a) => a === '--version' || a.startsWith('--version='));
    let version: string | undefined;
    if (versionFlagIdx >= 0) {
      const a = rest[versionFlagIdx] as string;
      version = a.startsWith('--version=') ? a.slice('--version='.length) : rest[versionFlagIdx + 1];
    }
    await runSelfUpdateCommand({ version });
    return;
  }
  if (cmd === 'uninstall') {
    // Above the resolved-home gate on purpose: uninstall must work on a
    // half-broken install, or with no home at all.
    const { runUninstallCommand } = await import('./commands/uninstall.ts');
    await runUninstallCommand({
      yes: rest.includes('--yes') || rest.includes('-y'),
      purge: rest.includes('--purge'),
      images: rest.includes('--images'),
      binary: rest.includes('--binary'),
    });
    return;
  }

  // Everything below needs a home. Pre-checking here (util.ts would resolve
  // lazily anyway) separates "no install" from "install with no .env".
  const resolved = resolveSubwaveHome();
  if (!resolved) {
    process.stderr.write(
      'No SUB/WAVE install found.\n\n' +
      'Run `subwave init` to scaffold a fresh install at ~/subwave,\n' +
      'or pass --home <path> to point at an existing one.\n',
    );
    process.exit(2);
  }

  // The legacy controller/.env counts too. `init` is exempt: it writes .env.
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
    case 'sync': {
      const { runSyncCommand } = await import('./commands/sync.ts');
      await runSyncCommand({ check: rest.includes('--check') });
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
