// Controller HTTP client: resolves the base URL for the live compose env and
// attaches admin Basic auth when the root .env has creds. Missing creds are
// survivable in dev, where the controller skips its auth gate.

import { apiBaseFor, type ComposeEnv } from './compose.ts';
import { getLegacyControllerEnv, getRootEnv, parseEnvFile, fetchErrorReason } from './util.ts';

export interface AdminCreds {
  user: string;
  pass: string;
}

export function readAdminCreds(): AdminCreds | null {
  // Legacy controller/.env fallback for an upgrader who hasn't re-run setup.
  for (const path of [getRootEnv(), getLegacyControllerEnv()]) {
    const env = parseEnvFile(path);
    if (env.ADMIN_USER && env.ADMIN_PASS) {
      return { user: env.ADMIN_USER, pass: env.ADMIN_PASS };
    }
  }
  return null;
}

export interface ApiClient {
  base: string;
  get<T = unknown>(path: string, opts?: { admin?: boolean; timeoutMs?: number }): Promise<ApiResponse<T>>;
  post<T = unknown>(
    path: string,
    body: unknown,
    opts?: { admin?: boolean; timeoutMs?: number },
  ): Promise<ApiResponse<T>>;
}

export interface ApiResponse<T> {
  ok: boolean;
  status: number;
  body: T | null;
  error?: string;
}

export function makeClient(env: ComposeEnv): ApiClient {
  const base = apiBaseFor(env);
  const creds = readAdminCreds();
  const authHeader = creds
    ? `Basic ${Buffer.from(`${creds.user}:${creds.pass}`).toString('base64')}`
    : null;

  async function call<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    opts: { admin?: boolean; timeoutMs?: number } = {},
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (opts.admin && authHeader) headers.Authorization = authHeader;
    if (method === 'POST') headers['Content-Type'] = 'application/json';

    const url = base + (path.startsWith('/') ? path : '/' + path);
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
      });
      let parsed: T | null = null;
      const text = await res.text();
      if (text) {
        try { parsed = JSON.parse(text) as T; }
        catch { parsed = null; }
      }
      return {
        ok: res.ok,
        status: res.status,
        body: parsed,
        error: res.ok ? undefined : `HTTP ${res.status}`,
      };
    } catch (e) {
      return { ok: false, status: 0, body: null, error: fetchErrorReason(e) };
    }
  }

  return {
    base,
    get: <T>(path: string, opts?: { admin?: boolean; timeoutMs?: number }) =>
      call<T>('GET', path, undefined, opts),
    post: <T>(path: string, body: unknown, opts?: { admin?: boolean; timeoutMs?: number }) =>
      call<T>('POST', path, body, opts),
  };
}

// null means "don't know", so callers stay quiet. Unauthenticated endpoint.
export async function checkNeedsSetup(env: ComposeEnv): Promise<boolean | null> {
  const client = makeClient(env);
  const r = await client.get<{ needsSetup?: boolean }>('/onboarding/status', { timeoutMs: 2000 });
  if (!r.ok || r.body == null || typeof r.body.needsSetup !== 'boolean') return null;
  return r.body.needsSetup;
}

// Polls until the controller reports on-air, so `subwave start` reports more
// than "compose exited 0".
export async function waitForHealth(
  env: ComposeEnv,
  timeoutMs = 30_000,
  onTick?: (elapsedMs: number) => void,
): Promise<boolean> {
  const client = makeClient(env);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await client.get<{ status?: string }>('/health', { timeoutMs: 1500 });
    if (r.ok && r.body?.status === 'on-air') return true;
    if (onTick) onTick(Date.now() - start);
    await new Promise((res) => setTimeout(res, 1000));
  }
  return false;
}

// Keep field names in step with what controller/src/routes/public.js emits.
export interface NowPlayingPayload {
  nowPlaying?: {
    title?: string;
    artist?: string;
    album?: string;
    timestamp?: number; // unix seconds, when the track started
    subsonic_id?: string;
  };
  dj?: { name?: string; tagline?: string };
  context?: {
    dominantMood?: string;
    weather?: { condition?: string; temp?: number; location?: string };
  };
  streamOnline?: boolean;
  listeners?: { current?: number; peak?: number };
  session?: { id?: string; kind?: string; show?: string | null };
  activeShow?: { id?: string; name?: string } | null;
}

export interface StatePayload {
  upcoming?: Array<{ title?: string; artist?: string }>;
  current?: { title?: string; artist?: string };
  history?: Array<{ title?: string; artist?: string; playedAt?: number }>;
  // Entries also carry id + meta; declared here only as far as we render.
  djLog?: Array<{ kind?: string; message?: string; t?: string }>;
}
