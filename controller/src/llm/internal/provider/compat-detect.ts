// What kind of server sits behind an `openai-compatible` connection, and so
// which compatibility mode it wants.
//
// The two modes are not interchangeable. A self-hosted server (llama.cpp,
// LM Studio, vLLM, Ollama's /v1) running a small model needs `local`: the
// forced-tool object path, one discovery round, and the repeat_penalty /
// num_ctx / chat_template_kwargs body extras. A hosted API or proxy fronting a
// cloud model needs `hosted`: driven in `local` mode, its agent loop stops
// without the forced `done` call after a few tool rounds and every pick lands
// on the recovery path. `auto` reads the server instead of asking the operator
// to know which one they run.
//
// The failure direction is deliberate: anything short of positive evidence
// resolves to `local`, the historical behaviour. Wrongly calling a small local
// model `hosted` drops the forced tool and the sampling extras it depends on,
// which is the worse mistake; the doctor check names the other one.
//
// The classifier is pure; the probe and the cache are the only impure parts.

export type CompatMode = 'local' | 'hosted';

export type CompatServer =
  | 'llama.cpp' | 'lm-studio' | 'ollama' | 'vllm' | 'local-server' | 'hosted-api';

export interface CompatDetection {
  // null = no positive evidence either way (unreachable, or a server that
  // identifies as neither). Callers treat it as `local`.
  mode: CompatMode | null;
  server: CompatServer | null;
  // One operator-readable line saying what was seen.
  evidence: string;
  at: number;
}

// What a probe saw, as plain data so the classifier can be tested without a
// network. Every field is optional: a probe that failed leaves its field unset.
export interface CompatEvidence {
  baseUrl: string;
  model?: string;
  // GET <root>/props answered with llama.cpp's server properties.
  llamaCppProps?: boolean;
  // GET <root>/api/v0/models answered with LM Studio's model list.
  lmStudioApi?: boolean;
  // GET <root>/api/version answered with Ollama's {version}.
  ollamaVersion?: boolean;
  // GET <base>/models: the `owned_by` values and ids it listed.
  modelsOwnedBy?: string[];
  modelIds?: string[];
  // Did any probe get an HTTP answer at all?
  reachable?: boolean;
}

// `owned_by` values self-hosted servers put in their /v1/models list.
// llama.cpp: "llamacpp"; vLLM: "vllm"; LM Studio: "organization_owner";
// Ollama: "library"/"ollama"; koboldcpp, TabbyAPI, LocalAI name themselves.
const LOCAL_OWNERS: ReadonlyMap<string, CompatServer> = new Map([
  ['llamacpp', 'llama.cpp'],
  ['llama.cpp', 'llama.cpp'],
  ['vllm', 'vllm'],
  ['organization_owner', 'lm-studio'],
  ['library', 'ollama'],
  ['ollama', 'ollama'],
  ['koboldcpp', 'local-server'],
  ['tabbyapi', 'local-server'],
  ['localai', 'local-server'],
]);

// Model families only reachable as a cloud API. A proxy that lists or serves
// one of these is fronting a hosted model, whatever address it listens on.
const CLOUD_MODEL_RE = /^(?:[\w.-]+\/)?(?:claude|gpt-|chatgpt|o[1-9](?:-|$)|gemini|grok|command-[ar]|sonar|mistral-(?:large|medium|small)|codestral|magistral|deepseek-(?:chat|reasoner))/i;

export function isCloudModelId(id: unknown): boolean {
  return typeof id === 'string' && CLOUD_MODEL_RE.test(id.trim());
}

// A public DNS name over HTTPS is a hosted API. An IP literal, localhost, a
// private/CGNAT (Tailscale) range or a LAN-style suffix is not evidence of
// anything: a hosted proxy can listen there too, so it stays undecided.
export function isPublicHttpsHost(baseUrl: string): boolean {
  let url: URL;
  try { url = new URL(baseUrl); } catch { return false; }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host.includes('.')) return false;
  if (/^[\d.]+$/.test(host) || host.includes(':')) return false;
  return !/(?:^|\.)(?:localhost|local|lan|home|internal|intranet|corp|ts\.net|home\.arpa)$/.test(host);
}

export function classifyCompatibleServer(e: CompatEvidence, now = Date.now()): CompatDetection {
  const owners = (e.modelsOwnedBy ?? []).map(o => String(o).toLowerCase());
  const owned = owners.map(o => LOCAL_OWNERS.get(o)).find(Boolean);
  const local = (server: CompatServer, evidence: string): CompatDetection => ({ mode: 'local', server, evidence, at: now });
  const hosted = (evidence: string): CompatDetection => ({ mode: 'hosted', server: 'hosted-api', evidence, at: now });

  // A self-hosted signature wins over every hosted hint: LiteLLM-style routers
  // can list cloud ids beside a local model, but a llama.cpp /props cannot lie.
  if (e.llamaCppProps) return local('llama.cpp', 'answers llama.cpp /props');
  if (e.lmStudioApi) return local('lm-studio', 'answers LM Studio /api/v0/models');
  if (e.ollamaVersion) return local('ollama', 'answers Ollama /api/version');
  if (owned) return local(owned, `models are owned_by "${owners.find(o => LOCAL_OWNERS.has(o))}"`);

  if (isCloudModelId(e.model)) return hosted(`model "${e.model}" is a cloud model`);
  if (!e.model && e.modelIds?.some(isCloudModelId)) {
    return hosted(`lists cloud models (${e.modelIds.filter(isCloudModelId).slice(0, 2).join(', ')})`);
  }
  if (isPublicHttpsHost(e.baseUrl)) return hosted(`public HTTPS API (${new URL(e.baseUrl).hostname})`);

  return {
    mode: null,
    server: null,
    evidence: e.reachable ? 'server did not identify itself' : 'server unreachable',
    at: now,
  };
}

// The server root: the base URL without its trailing /v1, where llama.cpp,
// LM Studio and Ollama serve their own endpoints.
function serverRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '');
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

async function getJson(fetcher: Fetcher, url: string, headers: Record<string, string>, timeoutMs: number): Promise<{ answered: boolean; ok: boolean; body: any }> {
  try {
    const res = await fetcher(url, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) });
    let body: any = null;
    if (res.ok) {
      try { body = await res.json(); } catch { body = null; }
    }
    return { answered: true, ok: res.ok, body };
  } catch {
    return { answered: false, ok: false, body: null };
  }
}

// Probe the server behind one leg's config. Never throws: an unreachable or
// silent server is evidence of nothing, and classifies as undecided.
export async function probeCompatibleServer(
  cfg: { baseUrl?: string; model?: string; apiKey?: string; headers?: Record<string, string> },
  { fetcher = fetch as Fetcher, timeoutMs = 3000, now = Date.now }: { fetcher?: Fetcher; timeoutMs?: number; now?: () => number } = {},
): Promise<CompatDetection> {
  const baseUrl = String(cfg?.baseUrl || '').trim().replace(/\/+$/, '');
  if (!baseUrl) return { mode: null, server: null, evidence: 'no base URL', at: now() };
  const root = serverRoot(baseUrl);
  const headers: Record<string, string> = { ...(cfg.headers || {}) };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

  const [models, props, lmStudio, ollama] = await Promise.all([
    getJson(fetcher, `${baseUrl}/models`, headers, timeoutMs),
    getJson(fetcher, `${root}/props`, headers, timeoutMs),
    getJson(fetcher, `${root}/api/v0/models`, headers, timeoutMs),
    getJson(fetcher, `${root}/api/version`, headers, timeoutMs),
  ]);
  const list: any[] = Array.isArray(models.body?.data) ? models.body.data : [];
  return classifyCompatibleServer({
    baseUrl,
    model: String(cfg.model || '').trim() || undefined,
    llamaCppProps: !!(props.ok && props.body && typeof props.body === 'object'
      && ('default_generation_settings' in props.body || 'total_slots' in props.body || 'build_info' in props.body)),
    lmStudioApi: !!(lmStudio.ok && Array.isArray(lmStudio.body?.data)),
    ollamaVersion: !!(ollama.ok && typeof ollama.body?.version === 'string'),
    modelsOwnedBy: list.map(m => m?.owned_by).filter((o): o is string => typeof o === 'string'),
    modelIds: list.map(m => m?.id).filter((id): id is string => typeof id === 'string'),
    reachable: models.answered || props.answered || lmStudio.answered || ollama.answered,
  }, now());
}

// ---------------------------------------------------------------------------
// Cache. Keyed on what the answer depends on: the server and the model asked
// for (the model id is itself evidence). A decided answer is kept an hour — a
// server does not change kind under a station — and an undecided one is
// retried after two minutes, so a server that was down at boot is classified
// once it comes up.
// ---------------------------------------------------------------------------

const DECIDED_TTL_MS = 60 * 60 * 1000;
const UNDECIDED_TTL_MS = 2 * 60 * 1000;

const cache = new Map<string, CompatDetection>();
const inFlight = new Map<string, Promise<CompatDetection>>();

function keyOf(cfg: any): string {
  return `${String(cfg?.baseUrl || '').trim().replace(/\/+$/, '')}|${String(cfg?.model || '').trim()}`;
}

function fresh(d: CompatDetection | undefined, now: number): boolean {
  if (!d) return false;
  return now - d.at < (d.mode ? DECIDED_TTL_MS : UNDECIDED_TTL_MS);
}

// Probe now, sharing one in-flight probe per key. Resolves with the detection
// and caches it; never rejects.
export function detectCompatibleMode(cfg: any, opts: Parameters<typeof probeCompatibleServer>[1] = {}): Promise<CompatDetection> {
  const key = keyOf(cfg);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const run = probeCompatibleServer(cfg, opts)
    .then(d => { cache.set(key, d); return d; })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

// The last detection for this config, or null if none has finished yet.
export function cachedCompatDetection(cfg: any): CompatDetection | null {
  return cache.get(keyOf(cfg)) ?? null;
}

// Test seam.
export function clearCompatDetectionCache(): void {
  cache.clear();
  inFlight.clear();
}

// The mode a leg actually runs in. Only `auto` on an openai-compatible leg is
// resolved; an explicit choice is the operator's and is returned untouched.
// Synchronous, because it sits on every model call: it reads the cache and,
// when the answer is missing or stale, starts a background probe whose result
// the NEXT call sees. Until then `auto` behaves as `local`.
export function resolveCompatibleMode<T extends { provider?: string; compatibleMode?: string }>(cfg: T): T {
  if (cfg?.provider !== 'openai-compatible' || cfg.compatibleMode !== 'auto') return cfg;
  const hit = cache.get(keyOf(cfg));
  if (!fresh(hit, Date.now()) && String((cfg as any).baseUrl || '').trim()) {
    void detectCompatibleMode(cfg);
  }
  return { ...cfg, compatibleMode: hit?.mode ?? 'local', compatibleModeSetting: 'auto' };
}
