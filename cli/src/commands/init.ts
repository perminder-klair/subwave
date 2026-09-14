// `subwave init` — scaffold a fresh install directory. The only command that
// runs before a home exists: writes the embedded compose files + a 3-var .env,
// then records the home in ~/.config/subwave/config.json for later commands.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import crypto from 'node:crypto';

import { COMPOSE_YML, COMPOSE_BYO_YML, COMPOSE_TTS_HEAVY_GPU_YML, COMPOSE_ANALYZER_GPU_YML, ENV_EXAMPLE } from '../assets.ts';
import { DEFAULT_SUBWAVE_HOME, writeHomeConfig } from '../home.ts';
import { loadConfig, saveConfig } from '../config.ts';
import { writeEnvFile } from '../util.ts';
import { cliImageTag } from '../version.ts';
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
  tz: string;
}

// Without TZ the container runs in UTC and the DJ's time announcements drift by
// the host's offset (#205). Fallback is the compose default, not UTC.
function detectTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/London';
}

// `--yes` is for the curl|sh installer: it must skip every prompt, because on
// macOS Bun delivers no stdin from a piped parent (oven-sh/bun#13374) and the
// first Clack prompt would hang un-killably.
export interface InitOptions {
  yes?: boolean;
  mode?: Mode;
  adminUser?: string;
  adminPass?: string;
  siteUrl?: string;
  tz?: string; // defaults to the detected host zone
  start?: boolean; // default true; the installer's `--no-start` maps to false
}

export async function runInitCommand(opts: InitOptions = {}): Promise<void> {
  banner('install');
  info('Scaffolds a fresh install directory, writes the compose file + .env, and records the home so future commands know where to look.');
  muted('After this, run `subwave start` then `subwave setup` to finish configuration.');
  console.log();

  const answers = opts.yes ? defaultAnswers(opts) : await collectAnswers();
  await scaffold(answers);

  if (opts.yes) {
    if (opts.start !== false) {
      await runStartCommand();
    } else {
      console.log();
      muted('Next:');
      muted('  subwave start          # docker compose up -d');
      muted('  subwave setup          # configure Navidrome / LLM / TTS / DJ');
    }
    return;
  }

  // scaffold() just persisted preferredEnv, so runStartCommand() won't re-ask.
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

// Mirrors collectAnswers()'s defaults, minus the prompts. Never clobbers an
// existing install.
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
    tz: opts.tz?.trim() || detectTimezone(),
  };
}

async function collectAnswers(): Promise<InitAnswers> {
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

  // Dev isn't an option here — devs use `git clone` + `npm start`, no init step.
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

  // Mandatory in prod — the controller exits without them.
  const adminUser = exitIfCancelled(await p.text({
    message: 'Admin username (gates /admin and /onboarding)',
    initialValue: 'admin',
    placeholder: 'admin',
  }), { backOnCancel: false });

  const adminPass = exitIfCancelled(await p.password({
    message: 'Admin password (leave blank to generate a random one)',
  }), { backOnCancel: false }) || crypto.randomBytes(16).toString('hex');

  // Cosmetic: OG cards, canonical URLs, sitemap, manifest. Blank falls back to
  // a localhost origin.
  const siteUrl = exitIfCancelled(await p.text({
    message: 'Public site URL (https://radio.example.com — blank to defer)',
    initialValue: '',
    placeholder: 'https://radio.example.com',
  }), { backOnCancel: false });

  // TZ is detected, not prompted; `subwave setup` owns the editable prompt.
  return { home: homeAbs, mode, adminUser, adminPass, siteUrl, tz: detectTimezone() };
}

async function scaffold(a: InitAnswers): Promise<void> {
  header('Scaffolding install');

  // state/ gets the operator's UID so the containers mounting it need no chown.
  mkdirSync(a.home, { recursive: true });
  mkdirSync(resolve(a.home, 'state'), { recursive: true });
  mkdirSync(resolve(a.home, 'state', 'logs'), { recursive: true });
  ok(`created ${a.home}/ (state/, state/logs/)`);

  // Both modes get the BYO variant and the GPU overlays (#1099) so switching
  // later needs no re-init.
  const composeMainSrc = a.mode === 'prod-byo' ? COMPOSE_BYO_YML : COMPOSE_YML;
  writeFileSync(resolve(a.home, 'docker-compose.yml'), composeMainSrc);
  writeFileSync(resolve(a.home, 'docker-compose.byo.yml'), COMPOSE_BYO_YML);
  writeFileSync(resolve(a.home, 'docker-compose.tts-heavy-gpu.yml'), COMPOSE_TTS_HEAVY_GPU_YML);
  writeFileSync(resolve(a.home, 'docker-compose.analyzer-gpu.yml'), COMPOSE_ANALYZER_GPU_YML);
  if (a.mode === 'prod-byo') {
    ok('wrote docker-compose.yml (BYO-proxy variant) + docker-compose.byo.yml + GPU overlays');
  } else {
    ok('wrote docker-compose.yml (bundled Caddy) + docker-compose.byo.yml + GPU overlays');
  }

  // writeEnvFile() reads its template off disk, so .env.example must land first;
  // going through it keeps the shipped comments and key order.
  const envExamplePath = resolve(a.home, '.env.example');
  writeFileSync(envExamplePath, ENV_EXAMPLE);
  const envValues: Record<string, string> = {
    ADMIN_USER: a.adminUser,
    ADMIN_PASS: a.adminPass,
    TZ: a.tz,
  };
  if (a.siteUrl) envValues.SITE_URL = a.siteUrl;
  const envPath = resolve(a.home, '.env');
  writeEnvFile(envPath, envValues, { templateFallback: envExamplePath });
  ok(`wrote .env (ADMIN_USER, ADMIN_PASS, TZ=${a.tz}${a.siteUrl ? ', SITE_URL' : ''})`);

  // Unpinned, image refs float on :latest and can drift ahead of the compose
  // files this binary carries. A dev build has no tag to pin to.
  const pinTag = cliImageTag();
  if (pinTag) {
    applyVersionPin(envPath, pinTag);
    ok(`pinned SUBWAVE_VERSION=${pinTag} (images track this CLI; delete the line to follow :latest)`);
  } else {
    warn('CLI has no published release version — leaving SUBWAVE_VERSION unset (images follow :latest).');
  }

  // Lets later commands resolve this install without --home or SUBWAVE_HOME.
  writeHomeConfig({ home: a.home });
  ok('recorded install path in ~/.config/subwave/config.json');

  // preferredEnv is what makes future `subwave start` skip the env prompt.
  saveConfig({ ...loadConfig(), preferredEnv: a.mode });

  // A generated password is shown once and lives only in the .env just written.
  if (!process.env.SUBWAVE_QUIET_GENERATED_PASS) {
    console.log();
    info(`admin user: ${pc.bold(a.adminUser)}`);
    info(`admin pass: ${pc.bold(a.adminPass)}`);
    muted('Stored in .env at the install dir. Visible to anyone with shell access — protect accordingly.');
  }
}

// Hand-written because writeEnvFile() can't carry a comment for an appended
// key. Order: rewrite an active pin, else replace the template's commented
// `# SUBWAVE_VERSION=` line in place, else append a fresh block.
function applyVersionPin(envPath: string, tag: string): void {
  const lines = readFileSync(envPath, 'utf8').split('\n');
  const block = [
    "# Pin every image to this install's CLI release — each compose image ref",
    `# resolves to ghcr.io/…/subwave-*:${tag}. Delete this line to follow :latest.`,
    `SUBWAVE_VERSION=${tag}`,
  ];

  const activeIdx = lines.findIndex((l) => /^SUBWAVE_VERSION\s*=/.test(l));
  const commentIdx = lines.findIndex((l) => /^#\s*SUBWAVE_VERSION\s*=/.test(l));

  if (activeIdx >= 0) {
    lines[activeIdx] = `SUBWAVE_VERSION=${tag}`;
  } else if (commentIdx >= 0) {
    lines.splice(commentIdx, 1, ...block);
  } else {
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    lines.push('', ...block);
  }

  let content = lines.join('\n');
  if (!content.endsWith('\n')) content += '\n';
  writeFileSync(envPath, content);
}
