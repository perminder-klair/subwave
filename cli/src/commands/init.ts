// `subwave init` — scaffold a fresh SUB/WAVE install directory.
//
// The standalone-CLI entry point. Unlike `subwave setup` (which assumes the
// stack is already installed somewhere and runs the configuration wizard),
// `init` is the very first command — it asks where to install, materialises
// the embedded compose files + a 3-var .env into that directory, and records
// the home in ~/.config/subwave/config.json so subsequent commands know
// where to look.
//
// After init, the operator runs `subwave start` (which brings docker up)
// and `subwave setup` (the full wizard for Navidrome / LLM / TTS / DJ).

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import crypto from 'node:crypto';

import { COMPOSE_YML, COMPOSE_BYO_YML, ENV_EXAMPLE } from '../assets.ts';
import { DEFAULT_SUBWAVE_HOME, writeHomeConfig } from '../home.ts';
import { loadConfig, saveConfig } from '../config.ts';
import { writeEnvFile } from '../util.ts';
import { runStartCommand } from './start.ts';
import {
  banner, header, ok, warn, err, info, muted, p, pc, exitIfCancelled, pauseForEnter,
} from '../ui.ts';

type Mode = 'prod' | 'prod-byo';

interface InitAnswers {
  home: string;
  mode: Mode;
  adminUser: string;
  adminPass: string;
  siteUrl: string;
}

// Options for non-interactive init (`subwave init --yes`). Used by the curl|sh
// installer, which must NOT drive an interactive Clack prompt through the pipe:
// on macOS Bun doesn't deliver stdin bytes when launched from a piped parent
// (oven-sh/bun#13374), so the first prompt would hang un-killably. `--yes`
// skips every prompt, applies sane defaults (overridable via the flags below),
// and is therefore immune to that bug.
export interface InitOptions {
  yes?: boolean;
  mode?: Mode;
  adminUser?: string;
  adminPass?: string;
  siteUrl?: string;
  // Whether to bring the stack up after scaffolding. Defaults to true; the
  // installer's `--no-start` maps to false.
  start?: boolean;
}

export async function runInitCommand(opts: InitOptions = {}): Promise<void> {
  banner('install');
  info('Scaffolds a fresh install directory, writes the compose file + .env, and records the home so future commands know where to look.');
  muted('After this, run `subwave start` then `subwave setup` to finish configuration.');
  console.log();

  const answers = opts.yes ? defaultAnswers(opts) : await collectAnswers();
  await scaffold(answers);

  // Non-interactive (`--yes`): no "start now?" prompt — `opts.start` decides.
  if (opts.yes) {
    if (opts.start !== false) {
      await runStartCommand();
    } else {
      console.log();
      muted('Next:');
      muted('  subwave start          # docker compose up -d');
      muted('  subwave setup          # configure Navidrome / LLM / TTS / DJ (and change install dir / mode)');
    }
    return;
  }

  // Offer to chain straight into `start` so the curl|sh → init → on-air flow
  // is one decision long. preferredEnv was just persisted by scaffold(), so
  // runStartCommand() resolves the env silently — no second prompt. A no
  // here is non-fatal: operators who want to inspect/tweak the .env before
  // first boot fall through to pauseForEnter(); `subwave start` is the
  // obvious next command and `subwave --help` lists everything else.
  console.log();
  const startNow = exitIfCancelled(await p.confirm({
    message: 'Bring the stack up now?',
    initialValue: true,
  }), { backOnCancel: false });
  if (startNow) {
    await runStartCommand();
    return;
  }
  await pauseForEnter();
}

// Build InitAnswers from defaults + flag overrides, no prompts. Mirrors the
// defaults baked into collectAnswers() (home = SUBWAVE_HOME or ~/subwave, prod
// mode, admin user "admin", generated password, blank site URL). Refuses to
// clobber an existing install — destroying compose files non-interactively is
// never the right default.
function defaultAnswers(opts: InitOptions): InitAnswers {
  const envHome = process.env.SUBWAVE_HOME?.trim();
  const homeRaw = envHome || DEFAULT_SUBWAVE_HOME;
  const homeAbs = homeRaw.startsWith('~/') ? resolve(homedir(), homeRaw.slice(2)) : resolve(homeRaw);

  if (existsSync(resolve(homeAbs, 'docker-compose.yml'))) {
    warn(`${homeAbs} already contains a docker-compose.yml — leaving it untouched.`);
    muted(`(Run \`subwave start\` to boot it, or \`subwave init\` interactively to scaffold elsewhere.)`);
    process.exit(0);
  }

  return {
    home: homeAbs,
    mode: opts.mode ?? 'prod',
    adminUser: opts.adminUser ?? 'admin',
    adminPass: opts.adminPass ?? crypto.randomBytes(16).toString('hex'),
    siteUrl: opts.siteUrl ?? '',
  };
}

async function collectAnswers(): Promise<InitAnswers> {
  // 1. Install directory.
  const home = exitIfCancelled(await p.text({
    message: 'Install directory',
    initialValue: DEFAULT_SUBWAVE_HOME,
    placeholder: DEFAULT_SUBWAVE_HOME,
    validate: (v) => {
      if (!v) return 'Required.';
      if (!v.startsWith('/') && !v.startsWith('~/')) return 'Use an absolute path or ~/something.';
      return undefined;
    },
  }), { backOnCancel: false });
  const homeAbs = home.startsWith('~/') ? resolve(homedir(), home.slice(2)) : resolve(home);

  // If the directory already has a compose file, refuse to clobber it.
  if (existsSync(resolve(homeAbs, 'docker-compose.yml'))) {
    warn(`${homeAbs} already contains a docker-compose.yml.`);
    const overwrite = exitIfCancelled(await p.confirm({
      message: 'Overwrite the existing compose file and .env?',
      initialValue: false,
    }), { backOnCancel: false });
    if (!overwrite) {
      muted('Aborted — nothing changed.');
      muted(`(To run commands against this existing install, just \`cd ${homeAbs}\` first or pass --home ${homeAbs}.)`);
      process.exit(0);
    }
  }

  // 2. Mode. Dev isn't an init option — devs use `git clone` + `npm start`,
  // which doesn't need an init step.
  const mode = exitIfCancelled(await p.select<Mode>({
    message: 'Deployment shape',
    initialValue: 'prod',
    options: [
      {
        value: 'prod',
        label: 'prod — bundled Caddy on :7700',
        hint: 'docker-compose.yml · single host port · Cloudflare-fronted',
      },
      {
        value: 'prod-byo',
        label: 'prod (BYO proxy) — Traefik / nginx / your own Caddy',
        hint: 'docker-compose.byo.yml · web :7700 · controller :7701 · broadcast :7702',
      },
    ],
  }), { backOnCancel: false });

  // 3. Admin credentials. ADMIN_USER + ADMIN_PASS are mandatory in prod
  // (controller exits without them). Generate ADMIN_PASS for the operator
  // if they leave it blank — easier to copy from the wizard output than to
  // remember to `openssl rand -hex 16`.
  const adminUser = exitIfCancelled(await p.text({
    message: 'Admin username (gates /admin and /onboarding)',
    initialValue: 'admin',
    placeholder: 'admin',
  }), { backOnCancel: false });

  const adminPass = exitIfCancelled(await p.password({
    message: 'Admin password (leave blank to generate a random one)',
  }), { backOnCancel: false }) || crypto.randomBytes(16).toString('hex');

  // 4. SITE_URL. Cosmetic but recommended in prod (drives OG / Twitter
  // share cards, canonical URLs, sitemap, manifest). Blank is fine — it'll
  // fall back to a localhost origin, which just means social previews are
  // broken until the operator sets it.
  const siteUrl = exitIfCancelled(await p.text({
    message: 'Public site URL (https://radio.example.com — blank to defer)',
    initialValue: '',
    placeholder: 'https://radio.example.com',
  }), { backOnCancel: false });

  return { home: homeAbs, mode, adminUser, adminPass, siteUrl };
}

async function scaffold(a: InitAnswers): Promise<void> {
  header('Scaffolding install');

  // 1. Create the home directory + state/ subtree. State is created with
  // the operator's UID so broadcast/controller containers (which mount it)
  // don't need a chown dance on first boot.
  mkdirSync(a.home, { recursive: true });
  mkdirSync(resolve(a.home, 'state'), { recursive: true });
  mkdirSync(resolve(a.home, 'state', 'logs'), { recursive: true });
  ok(`created ${a.home}/ (state/, state/logs/)`);

  // 2. Write the compose file the operator chose. Both modes get a copy of
  // docker-compose.byo.yml alongside the default so operators can switch
  // later without re-running init.
  const composeMainSrc = a.mode === 'prod-byo' ? COMPOSE_BYO_YML : COMPOSE_YML;
  writeFileSync(resolve(a.home, 'docker-compose.yml'), composeMainSrc);
  writeFileSync(resolve(a.home, 'docker-compose.byo.yml'), COMPOSE_BYO_YML);
  if (a.mode === 'prod-byo') {
    ok('wrote docker-compose.yml (BYO-proxy variant) + docker-compose.byo.yml');
  } else {
    ok('wrote docker-compose.yml (bundled Caddy) + docker-compose.byo.yml');
  }

  // 3. Write .env from the embedded template, filling in the operator's
  // answers. writeEnvFile() preserves the template's comments + key order,
  // which keeps the file friendly to hand-edit later.
  //
  // Trick: the template lives inside the install dir as .env.example so
  // writeEnvFile() can read it back. We write .env.example first, then
  // call writeEnvFile() against it as the templateFallback.
  const envExamplePath = resolve(a.home, '.env.example');
  writeFileSync(envExamplePath, ENV_EXAMPLE);
  const envValues: Record<string, string> = {
    ADMIN_USER: a.adminUser,
    ADMIN_PASS: a.adminPass,
  };
  if (a.siteUrl) envValues.SITE_URL = a.siteUrl;
  writeEnvFileAt(resolve(a.home, '.env'), envValues, envExamplePath);
  ok(`wrote .env (ADMIN_USER, ADMIN_PASS${a.siteUrl ? ', SITE_URL' : ''})`);

  // 4. Persist the home in ~/.config/subwave/config.json so subsequent
  // `subwave …` commands resolve to this directory without --home or
  // SUBWAVE_HOME being set.
  writeHomeConfig({ home: a.home });
  ok('recorded install path in ~/.config/subwave/config.json');

  // Persist the chosen deployment shape as preferredEnv so future
  // `subwave start` invocations skip the env prompt — operators who chose
  // prod here will never be asked again. (Dev isn't an init option; clones
  // get inferred from the filesystem.)
  saveConfig({ ...loadConfig(), preferredEnv: a.mode });

  // 5. If the operator let us generate a password, surface it now — once.
  // No persistence beyond the .env we just wrote.
  if (!process.env.SUBWAVE_QUIET_GENERATED_PASS) {
    console.log();
    info(`admin user: ${pc.bold(a.adminUser)}`);
    info(`admin pass: ${pc.bold(a.adminPass)}`);
    muted('Stored in .env at the install dir. Visible to anyone with shell access — protect accordingly.');
  }
}

// Local copy of writeEnvFile that doesn't go through util.ts's getRootEnv()
// (which requires a resolved home — chicken-and-egg during init). The
// existing util.ts:writeEnvFile takes an explicit path, so we just call it
// directly; this wrapper is here in case we ever want init-specific behaviour.
function writeEnvFileAt(path: string, values: Record<string, string>, templateFallback: string): void {
  // Just delegate. Kept as a separate function so future init-only quirks
  // have somewhere obvious to land without touching util.ts.
  return writeEnvFile(path, values, { templateFallback });
}
