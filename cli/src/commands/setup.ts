// `subwave setup` — the configuration wizard, browser counterpart /onboarding.
//
// Boundary with `subwave init`: init scaffolds the filesystem and writes the
// boot-critical .env; setup configures a stack that is already RUNNING (it
// pushes through the live controller), so it exits rather than starting one.
// Probes are warn-not-fail — the operator can keep going if the network isn't
// ready yet.

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import {
  getLegacyControllerEnv,
  getSubwaveHome,
  getRootEnv,
  getRootEnvExample,
  parseEnvFile,
  readSetupConfig,
  writeEnvFile,
  have,
} from '../util.ts';
import { detectCompose, getComposeFiles, webBaseFor, streamUrlFor, apiBaseFor, type ComposeEnv } from '../compose.ts';
import { dockerDaemonOk } from '../docker.ts';
import { makeClient } from '../api.ts';
import {
  probeSubsonic,
  probeOllama,
  probeOpenAI,
  probeAnthropic,
  probeOpenRouter,
  probeRequesty,
  probeOrcarouter,
  type ProbeResult,
} from '../probes.ts';
import { p, pc, accent, exitIfCancelled, banner, header, ok, warn, err, info, muted } from '../ui.ts';

// Keep in step with the controller's LLM_PROVIDERS (controller/src/settings.ts).
// `locca` shares the openai-compatible transport but is keyless with a default
// host base URL, so it groups with the local providers rather than the cloud set.
type CloudProvider = 'anthropic' | 'openai' | 'google' | 'deepseek' | 'openrouter' | 'requesty' | 'orcarouter' | 'gateway';
type LlmProvider = 'ollama' | 'openai-compatible' | 'locca' | CloudProvider;

// Cloud providers whose API key the AI SDK reads from a process.env var.
// openai-compatible is deliberately absent — it has no canonical env var, so
// its key (when a self-hosted server needs one) goes into settings instead.
const CLOUD_ENV_VAR: Record<CloudProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  requesty: 'REQUESTY_API_KEY',
  orcarouter: 'ORCAROUTER_API_KEY',
  gateway: 'AI_GATEWAY_API_KEY',
};

interface LlmChoice {
  provider: LlmProvider | null; // null = "configure later"
  ollamaUrl?: string;
  ollamaModel?: string;
  baseUrl?: string; // openai-compatible / locca server URL, /v1 suffix included
  model?: string; // blank defers the choice to the admin UI
  // Cloud → state/secrets.env (0600), sourced into process.env on controller
  // boot. openai-compatible → settings.llm.apiKey (it has no canonical env var).
  apiKey?: string;
}

export async function runSetupCommand(): Promise<void> {
  banner('configuration wizard');

  // Admin creds are init's responsibility. Without them the controller exits at
  // boot in prod, so refusing here is the same gate, surfaced earlier.
  const existingRoot = parseEnvFile(getRootEnv());
  const legacy = parseEnvFile(getLegacyControllerEnv());
  const hasAdmin = (existingRoot.ADMIN_USER && existingRoot.ADMIN_PASS) ||
                   (legacy.ADMIN_USER && legacy.ADMIN_PASS);
  if (!hasAdmin) {
    err('No admin credentials found in .env.');
    muted('→ Run `subwave init` first — it scaffolds the install and writes ADMIN_USER + ADMIN_PASS.');
    process.exit(2);
  }

  // Cold-start is `subwave start`'s job, not ours.
  const current = detectCompose();
  if (current.env === 'down') {
    err('Stack is not running.');
    muted('→ Run `subwave start` first, then re-run `subwave setup`.');
    process.exit(2);
  }
  const mode = current.env;

  await preflight();
  const navidrome = await collectNavidrome();
  const llm = await collectLlm();
  const heavyTts = await promptHeavyTts();
  const heavyAnalysis = await promptHeavyAnalysis();
  const tz = await promptTimezone();
  const station = await promptStationName();

  // Setup only owns TZ, one-time SUBWAVE_HOMEPAGE and the two heavy-image
  // switches. Admin creds and SITE_URL come from init and survive because
  // writeEnvFile leaves existing keys alone when they aren't in the values map.
  header('Writing .env (repo root)');
  const envValues: Record<string, string> = { TZ: tz };
  if (!existingRoot.SUBWAVE_HOMEPAGE) envValues.SUBWAVE_HOMEPAGE = 'player';
  if (heavyTts) {
    const merged = mergeCsv(existingRoot.COMPOSE_PROFILES, 'tts-heavy');
    envValues.COMPOSE_PROFILES = merged;
  }
  if (heavyAnalysis) envValues.ANALYZER_HEAVY = '1';
  writeEnvFile(getRootEnv(), envValues, { templateFallback: getRootEnvExample() });
  ok(`wrote ${pc.dim('.env')} (${Object.keys(envValues).length} keys)`);
  if (heavyTts) {
    muted('Heavy TTS enabled — next `docker compose up -d` will start the tts-heavy sidecar.');
    muted('First start pulls ~5–6 GB of PyTorch + model weights from GHCR.');
  }
  if (heavyAnalysis) {
    muted('Heavy analysis enabled — next `docker compose up -d` pulls subwave-analyzer-heavy (~1.9 GB).');
  }

  await pushOnboardingSave(mode, navidrome, llm, station, heavyTts);
  await runBashSetup({ ...process.env });

  const wantsJingles = exitIfCancelled(await p.confirm({
    message: 'Generate station jingles now? (Piper TTS, ~30 s)',
    initialValue: false,
  }), { backOnCancel: false });
  if (wantsJingles) {
    const composeFile = getComposeFiles().find((f) => f.env === mode);
    if (composeFile) await renderJingles(composeFile.file, { ...process.env });
  }

  // Listen + Admin are what the operator actually clicks, so they get `info()`
  // (un-dimmed) above the secondary Stream / API / Reference lines.
  header('Endpoints');
  if (mode === 'prod') {
    const base = webBaseFor('prod');
    info(`Listen:  ${accent(`${base}/listen`)}`);
    info(`Admin:   ${accent(`${base}/admin`)}`);
    muted(`Stream:  ${accent(streamUrlFor('prod'))}`);
    muted(`API:     ${accent(`${apiBaseFor('prod')}/health`)}`);
  } else if (mode === 'prod-byo') {
    // The host ports the BYO compose file binds — what the operator's reverse
    // proxy should target. docker/Caddyfile has the route table to replicate.
    info(`Listen:      ${accent('http://localhost:7700/listen')}`);
    info(`Admin:       ${accent('http://localhost:7700/admin')}`);
    muted(`Web:         ${accent('http://localhost:7700')}  ${pc.dim('(point your proxy at this for /)')}`);
    muted(`API:         ${accent('http://localhost:7701')}  ${pc.dim('(route /api/* here, strip the /api prefix)')}`);
    muted(`Stream:      ${accent('http://localhost:7702/stream.mp3')}  ${pc.dim('(route /stream.mp3 here, disable buffering)')}`);
    muted(`Reference:   ${pc.dim('docker/Caddyfile — replicate this route table in your proxy')}`);
  } else {
    info(`Listen:      ${accent('http://localhost:7700/listen')}`);
    info(`Admin:       ${accent('http://localhost:7700/admin')}`);
    muted(`Controller:  ${accent('http://localhost:7701')}`);
    muted(`Stream:      ${accent('http://localhost:7702/stream.mp3')}`);
    muted(`Web (dev):   ${accent('http://localhost:7700')}  (separate: ` + pc.dim('`npm --prefix web run dev`') + ')');
  }

  console.log();
  ok('Setup complete.');
  muted(`Try ${pc.dim('`subwave status`')} or ${pc.dim('`subwave doctor`')}.`);
}

async function preflight(): Promise<void> {
  header('Preflight');
  const checks: Array<{ name: string; ok: boolean; fix?: string }> = [
    {
      name: `node ${process.versions.node}`,
      ok: Number(process.versions.node.split('.')[0]) >= 20,
      fix: 'install Node 20 or newer (https://nodejs.org)',
    },
    {
      name: 'docker on PATH',
      ok: have('docker'),
      fix: 'install Docker (https://docs.docker.com/get-docker/)',
    },
    {
      name: 'docker daemon reachable',
      ok: dockerDaemonOk(),
      fix: 'start Docker Desktop / dockerd',
    },
  ];
  for (const c of checks) {
    if (c.ok) ok(c.name);
    else err(`${c.name} — ${c.fix ?? 'unavailable'}`);
  }
  if (checks.some((c) => !c.ok)) {
    console.log();
    err('Resolve the failed prerequisites and re-run `subwave setup`.');
    process.exit(1);
  }
}

interface NavidromeCreds { url: string; user: string; pass: string; }

async function collectNavidrome(): Promise<NavidromeCreds> {
  // Pre-fill order, first non-empty wins: root .env → wizard overlay → legacy
  // controller/.env from a pre-single-compose install.
  const sc = readSetupConfig().navidrome || {};
  const rootEnv = parseEnvFile(getRootEnv());
  const legacy = parseEnvFile(getLegacyControllerEnv());
  let url = rootEnv.NAVIDROME_URL || sc.url || legacy.NAVIDROME_URL || 'http://localhost:4533';
  let user = rootEnv.NAVIDROME_USER || sc.user || legacy.NAVIDROME_USER || '';
  let pass = rootEnv.NAVIDROME_PASS || sc.pass || legacy.NAVIDROME_PASS || '';

  while (true) {
    header('Navidrome (Subsonic API)');
    muted('tip: a dedicated Navidrome user that can only access the libraries you');
    muted('want on air keeps audiobooks and seasonal collections off the stream');
    url = exitIfCancelled(await p.text({
      message: 'Navidrome URL',
      initialValue: url,
      placeholder: 'http://localhost:4533',
      validate: (v: string) => (v && !/^https?:\/\//.test(v) ? 'must start with http(s)://' : undefined),
    }), { backOnCancel: false });
    user = exitIfCancelled(await p.text({
      message: 'Navidrome user',
      initialValue: user,
      placeholder: 'admin',
      validate: (v: string) => (!v ? 'required' : undefined),
    }), { backOnCancel: false });
    pass = exitIfCancelled(await p.password({
      message: pass ? 'Navidrome password (enter to keep existing)' : 'Navidrome password',
      mask: '*',
    }), { backOnCancel: false }) || pass;

    const sp = p.spinner();
    sp.start('Probing Navidrome…');
    const result = await probeSubsonic({ url, user, pass });
    if (result.ok) {
      sp.stop('Navidrome auth ok');
      break;
    }
    sp.stop(pc.yellow('Navidrome probe failed'));
    warn(result.reason ?? 'unknown error');
    const next = exitIfCancelled(await p.select<'retry' | 'continue' | 'abort'>({
      message: 'What now?',
      initialValue: 'retry',
      options: [
        { value: 'retry', label: 'retry credentials' },
        { value: 'continue', label: 'continue anyway', hint: 'I will fix it later' },
        { value: 'abort', label: 'abort setup' },
      ],
    }), { backOnCancel: false });
    if (next === 'continue') break;
    if (next === 'abort') process.exit(1);
  }

  url = await maybeSwapLoopbackForContainer(url, 'Navidrome');

  return { url, user, pass };
}

// A loopback host resolves to the CONTROLLER CONTAINER, not the operator's
// machine. The compose files wire host.docker.internal to the host gateway via
// `extra_hosts`, so offer the swap now rather than letting the controller fail
// every call until the operator notices.
async function maybeSwapLoopbackForContainer(url: string, serviceLabel: string): Promise<string> {
  const loopbackMatch = url.match(/^(https?:\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i);
  if (!loopbackMatch) return url;
  const swapped = url.replace(loopbackMatch[2] as string, 'host.docker.internal');
  warn(
    `${url} points at your host's loopback. The controller runs in Docker, so this URL would resolve to the controller container itself rather than ${serviceLabel} on your host.`,
  );
  const ok = exitIfCancelled(await p.confirm({
    message: `Save as ${swapped} so the container can reach it?`,
    initialValue: true,
  }), { backOnCancel: false });
  if (ok) {
    muted(`using ${swapped}`);
    return swapped;
  }
  warn(
    `Keeping ${url} — the controller will fail to reach ${serviceLabel} unless you have a custom routing setup (e.g. host network mode).`,
  );
  return url;
}

// Probed from the HOST to seed the prompt's initial value; the loopback-swap
// step rewrites whatever we land on for the controller container.
async function detectOllamaUrl(): Promise<string | null> {
  const candidates = ['http://localhost:11434', 'http://127.0.0.1:11434'];
  for (const base of candidates) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 800);
      const r = await fetch(`${base}/api/tags`, { signal: ctrl.signal });
      clearTimeout(t);
      if (r.ok) return base;
    } catch {
      // unreachable — try the next candidate
    }
  }
  return null;
}

const LLM_PROVIDER_OPTIONS: Array<{ value: LlmProvider | 'later'; label: string; hint: string }> = [
  { value: 'ollama',            label: 'Ollama — local homelab',          hint: 'no API key — point at your homelab box' },
  { value: 'openai-compatible', label: 'OpenAI-compatible — self-hosted',  hint: 'llama.cpp, vLLM, LM Studio — your own server URL' },
  { value: 'locca',             label: 'locca — local llama.cpp',          hint: 'no API key — defaults to the host locca server' },
  { value: 'anthropic',         label: 'Anthropic — Claude',               hint: 'needs ANTHROPIC_API_KEY' },
  { value: 'openai',            label: 'OpenAI — GPT',                     hint: 'needs OPENAI_API_KEY' },
  { value: 'google',            label: 'Google — Gemini',                  hint: 'needs GOOGLE_GENERATIVE_AI_API_KEY' },
  { value: 'deepseek',          label: 'DeepSeek',                         hint: 'needs DEEPSEEK_API_KEY' },
  { value: 'openrouter',        label: 'OpenRouter — multi-vendor',        hint: 'needs OPENROUTER_API_KEY' },
  { value: 'requesty',          label: 'Requesty — multi-vendor',          hint: 'needs REQUESTY_API_KEY' },
  { value: 'orcarouter',        label: 'OrcaRouter — multi-vendor',        hint: 'needs ORCAROUTER_API_KEY' },
  { value: 'gateway',           label: 'Vercel AI Gateway — multi-vendor', hint: 'needs AI_GATEWAY_API_KEY' },
  { value: 'later',             label: 'Other / configure later',          hint: 'set it up in the admin UI' },
];

// Example model ids — placeholder hints only, not defaults.
const EXAMPLE_MODEL: Record<Exclude<LlmProvider, 'ollama'>, string> = {
  'openai-compatible': 'qwen3',
  locca: 'qwen3',
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-4o-mini',
  google: 'gemini-2.5-flash',
  deepseek: 'deepseek-chat',
  openrouter: 'anthropic/claude-sonnet-4-5',
  requesty: 'openai/gpt-4o-mini',
  orcarouter: 'orcarouter/auto',
  gateway: 'anthropic/claude-sonnet-4-5',
};

async function collectLlm(): Promise<LlmChoice> {
  header('LLM provider');
  const choice = exitIfCancelled(await p.select<LlmProvider | 'later'>({
    message: 'Which LLM should the AI DJ talk to?',
    initialValue: 'ollama',
    options: LLM_PROVIDER_OPTIONS,
  }), { backOnCancel: false });

  if (choice === 'later') return { provider: null };

  if (choice === 'ollama') {
    const detected = await detectOllamaUrl();
    if (detected) ok(`Detected Ollama on ${detected}`);
    let url = exitIfCancelled(await p.text({
      message: 'Ollama server URL',
      initialValue: detected || 'http://localhost:11434',
      placeholder: 'http://localhost:11434',
      validate: (v: string) => (!/^https?:\/\//.test(v) ? 'must start with http(s)://' : undefined),
    }), { backOnCancel: false });
    const model = exitIfCancelled(await p.text({
      // glm-5.1:cloud calls tools reliably (~97% on the picker-test harness,
      // ~2s/pick), which the DJ picker agent depends on. kimi-k2.6:cloud
      // honours tool calls only ~50% of the time — don't default to it.
      message: 'Ollama model (must be pulled on the server)',
      initialValue: 'glm-5.1:cloud',
      placeholder: 'glm-5.1:cloud',
      validate: (v: string) => (!v ? 'required' : undefined),
    }), { backOnCancel: false });
    await reportProbe('Ollama', () => probeOllama({ url, model }));
    url = await maybeSwapLoopbackForContainer(url, 'Ollama');
    return { provider: 'ollama', ollamaUrl: url, ollamaModel: model };
  }

  if (choice === 'openai-compatible') {
    const baseUrl = exitIfCancelled(await p.text({
      message: 'Server base URL (include the /v1 suffix)',
      placeholder: 'http://localhost:8080/v1',
      validate: (v: string) =>
        !v ? 'required' : !/^https?:\/\//.test(v) ? 'must start with http(s)://' : undefined,
    }), { backOnCancel: false });
    const model = exitIfCancelled(await p.text({
      message: 'Model id',
      placeholder: EXAMPLE_MODEL['openai-compatible'],
      validate: (v: string) => (!v ? 'required' : undefined),
    }), { backOnCancel: false });
    const apiKey = exitIfCancelled(await p.password({
      message: 'API key (optional — many self-hosted servers need none)',
      mask: '*',
    }), { backOnCancel: false });
    return { provider: 'openai-compatible', baseUrl, model, apiKey: apiKey || undefined };
  }

  if (choice === 'locca') {
    // Host-perspective URL, loopback-swapped for the container like Ollama's;
    // blank keeps the controller's built-in default. Local, so no API key.
    let url = exitIfCancelled(await p.text({
      message: 'locca server URL (blank = controller default, host :8080/v1)',
      initialValue: 'http://localhost:8080/v1',
      placeholder: 'http://localhost:8080/v1',
      validate: (v: string) => (v && !/^https?:\/\//.test(v) ? 'must start with http(s)://' : undefined),
    }), { backOnCancel: false });
    const model = exitIfCancelled(await p.text({
      message: 'locca model id',
      placeholder: EXAMPLE_MODEL.locca,
      validate: (v: string) => (!v ? 'required' : undefined),
    }), { backOnCancel: false });
    if (url) url = await maybeSwapLoopbackForContainer(url, 'locca');
    return { provider: 'locca', baseUrl: url || undefined, model };
  }

  const provider = choice; // narrowed to CloudProvider by the branches above

  const label = (LLM_PROVIDER_OPTIONS.find((o) => o.value === provider)?.label ?? provider)
    .split(' — ')[0] as string;
  const apiKey = exitIfCancelled(await p.password({
    message: `${label} API key`,
    mask: '*',
  }), { backOnCancel: false });
  const model = exitIfCancelled(await p.text({
    message: 'Model id (enter to choose later in the admin UI)',
    placeholder: EXAMPLE_MODEL[provider],
  }), { backOnCancel: false });
  if (!apiKey) {
    warn('No key provided — saving the provider choice; add the key later via the admin UI, the browser wizard at /setup, or by hand in state/secrets.env.');
  } else {
    await maybeProbeCloud(provider, label, apiKey);
  }
  return { provider, apiKey: apiKey || undefined, model: model || undefined };
}

// google / deepseek / gateway have no probe — their key is first exercised on
// the controller's first DJ call.
async function maybeProbeCloud(provider: CloudProvider, label: string, apiKey: string): Promise<void> {
  if (provider === 'openai') return reportProbe(label, () => probeOpenAI({ apiKey }));
  if (provider === 'anthropic') return reportProbe(label, () => probeAnthropic({ apiKey }));
  if (provider === 'openrouter') return reportProbe(label, () => probeOpenRouter({ apiKey }));
  if (provider === 'requesty') return reportProbe(label, () => probeRequesty({ apiKey }));
  if (provider === 'orcarouter') return reportProbe(label, () => probeOrcarouter({ apiKey }));
}

// Setting COMPOSE_PROFILES in .env is what brings the sidecar up on subsequent
// `docker compose up -d` without a `--profile` flag at the call site.
async function promptHeavyTts(): Promise<boolean> {
  header('Heavy TTS sidecar (optional)');
  muted('Chatterbox: zero-shot voice cloning. PocketTTS: 6x real-time multilingual.');
  muted('Adds a separate container; first start pulls ~5–6 GB.');
  return exitIfCancelled(await p.confirm({
    message: 'Enable the tts-heavy sidecar?',
    initialValue: false,
  }), { backOnCancel: false });
}

// CLAP "sounds-like" + Demucs vocal ranges need the CPU-torch stack, which only
// ships in the separate `subwave-analyzer-heavy` image; ANALYZER_HEAVY=1 is what
// repoints the analyzer service at it on the next `up -d`.
async function promptHeavyAnalysis(): Promise<boolean> {
  header('Heavy acoustic analysis (optional)');
  muted('Basic analysis (bpm/key/loudness) is already on. This adds CLAP');
  muted('"sounds-like" similarity + Demucs vocal ranges; pulls a ~1.9 GB image (amd64).');
  muted('NVIDIA GPU? Skip this and layer docker-compose.analyzer-gpu.yml instead —');
  muted('it runs the same features on CUDA (see docs/tts-heavy.md).');
  return exitIfCancelled(await p.confirm({
    message: 'Enable heavy analysis (sounds-like + vocals)?',
    initialValue: false,
  }), { backOnCancel: false });
}

// Merge into a comma-separated env var (COMPOSE_PROFILES), preserving the order
// of pre-existing entries.
function mergeCsv(prev: string | undefined, add: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of `${prev ?? ''},${add}`.split(',')) {
    const trimmed = v.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out.join(',');
}

async function promptTimezone(): Promise<string> {
  const detected = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  return exitIfCancelled(await p.text({
    message: 'Timezone (IANA id)',
    initialValue: detected,
    placeholder: 'Europe/London',
  }), { backOnCancel: false });
}

// Substituted into the {station} placeholder in renderDjPrompt().
async function promptStationName(): Promise<string> {
  return exitIfCancelled(await p.text({
    message: 'Station name (what the DJ calls this radio)',
    initialValue: 'SUB/WAVE',
    placeholder: 'SUB/WAVE',
    validate: (v) => (v.length > 80 ? 'Keep it to 80 characters or fewer.' : undefined),
  }), { backOnCancel: false });
}

async function runBashSetup(env: NodeJS.ProcessEnv): Promise<void> {
  // Clone mode delegates to scripts/setup.sh. Standalone installs have no
  // scripts/ dir, so inline the only step that still matters: state/ writable
  // by every container UID (they vary, hence 777). Idempotent either way.
  const { isCloneMode } = await import('../home.ts');
  if (!isCloneMode(getSubwaveHome())) {
    header('State directory perms (standalone install)');
    const { chmodSync, mkdirSync } = await import('node:fs');
    const stateDir = env.STATE_DIR ?? resolve(getSubwaveHome(), 'state');
    mkdirSync(stateDir, { recursive: true });
    try {
      chmodSync(stateDir, 0o777);
      ok(`chmod 777 ${stateDir}`);
    } catch (e) {
      warn(`could not chmod ${stateDir}: ${(e as Error).message}`);
      muted('broadcast/controller may fail to write there on first boot.');
    }
    return;
  }

  header('Bootstrapping state dirs + studio audio (scripts/setup.sh)');
  await new Promise<void>((resolveP, reject) => {
    const child = spawn('bash', ['scripts/setup.sh'], {
      cwd: getSubwaveHome(),
      env,
      stdio: 'inherit',
    });
    child.on('exit', (code) => {
      if (code === 0) resolveP();
      else reject(new Error(`scripts/setup.sh exited ${code}`));
    });
  }).catch((e) => {
    err(e.message);
    muted('Resolve and re-run setup.');
    process.exit(1);
  });
}

async function renderJingles(composeFile: string, env: NodeJS.ProcessEnv): Promise<void> {
  // Standalone installs don't ship scripts/generate-jingles.sh — send the
  // operator to /onboarding's jingle step, which hits the same endpoint.
  const { isCloneMode } = await import('../home.ts');
  if (!isCloneMode(getSubwaveHome())) {
    muted('Skipping jingle rendering — finish at /onboarding (Jingles step) or POST /jingles per ident text you want spoken.');
    return;
  }

  header('Rendering jingles');
  await new Promise<void>((resolveP) => {
    const child = spawn('bash', ['scripts/generate-jingles.sh'], {
      cwd: getSubwaveHome(),
      env: { ...env, COMPOSE_FILE: composeFile },
      stdio: 'inherit',
    });
    child.on('exit', (code) => {
      if (code === 0) ok('jingles rendered.');
      else warn(`jingle script exited ${code} — you can re-run it later via \`scripts/generate-jingles.sh\``);
      resolveP();
    });
  });
}

// Everything persists through /onboarding/save, the endpoint the browser wizard
// hits, so the controller owns the side-effects: the file writes, the in-memory
// config.navidrome.* reload, and the refreshAutoPlaylist() that brings the
// stream on air. The old "write the files from the host" path left the running
// controller stale until an explicit `subwave restart controller`.
async function pushOnboardingSave(
  env: ComposeEnv,
  navidrome: NavidromeCreds,
  llm: LlmChoice,
  station: string,
  heavyTts: boolean,
): Promise<void> {
  header('Saving via /onboarding/save');

  const body: Record<string, unknown> = {
    navidrome: { url: navidrome.url, user: navidrome.user, pass: navidrome.pass },
    station,
    // COMPOSE_PROFILES in .env is what actually starts the sidecar; this only
    // records the intent on settings, keeping both wizards' views consistent.
    tts: { heavyEnabled: heavyTts },
  };

  if (llm.provider) {
    const llmPatch: Record<string, unknown> = { provider: llm.provider };
    if (llm.provider === 'ollama') {
      if (llm.ollamaUrl) llmPatch.ollamaUrl = llm.ollamaUrl;
      if (llm.ollamaModel) llmPatch.model = llm.ollamaModel;
    } else if (llm.provider === 'openai-compatible' || llm.provider === 'locca') {
      // No canonical env var for these, so URL and key both live in settings.llm.
      if (llm.baseUrl) llmPatch.baseUrl = llm.baseUrl;
      if (llm.model) llmPatch.model = llm.model;
      if (llm.apiKey) llmPatch.apiKey = llm.apiKey;
    } else if (llm.model) {
      // Cloud keys ride body.apiKeys below instead, into state/secrets.env.
      llmPatch.model = llm.model;
    }
    body.llm = llmPatch;
  }

  if (llm.provider && llm.apiKey && llm.provider in CLOUD_ENV_VAR) {
    body.apiKeys = { [CLOUD_ENV_VAR[llm.provider as CloudProvider]]: llm.apiKey };
  }

  const client = makeClient(env);
  const res = await client.post('/onboarding/save', body, { admin: true, timeoutMs: 10_000 });
  if (res.ok) {
    ok('persisted — Navidrome + LLM saved, picker re-triggered');
  } else {
    err(`POST /onboarding/save failed: ${res.error ?? 'unknown'}`);
    muted('Nothing was persisted. Check `subwave logs controller`, then re-run `subwave setup`.');
    muted('Or finish in the browser at /onboarding (uses the same endpoint).');
    process.exit(1);
  }
}

async function reportProbe(label: string, run: () => Promise<ProbeResult>): Promise<void> {
  const sp = p.spinner();
  sp.start(`Probing ${label}…`);
  const r = await run();
  if (r.ok) {
    sp.stop(`${label} ok${r.detail ? ` — ${r.detail}` : ''}`);
  } else {
    sp.stop(pc.yellow(`${label} probe failed`));
    warn(r.reason ?? 'unknown error');
    const next = exitIfCancelled(await p.confirm({
      message: 'Continue anyway?',
      initialValue: true,
    }), { backOnCancel: false });
    if (!next) {
      muted('Resolve the issue and re-run `subwave setup`.');
      process.exit(1);
    }
  }
}

