// Reachability probes for the setup wizard. One uniform { ok, reason? } shape
// so the wizard renders every service the same way, and deliberately non-fatal:
// a real install often has Navidrome not up yet, cloud keys still to come, or an
// Ollama the wizard's host can't see, so the operator decides whether to retry,
// continue or abort.

import crypto from 'node:crypto';
import { fetchErrorReason } from './util.ts';

export interface ProbeResult {
  ok: boolean;
  reason?: string;        // human-readable failure summary, only set when !ok
  detail?: string;        // extra context for ok results (e.g. "32 models")
}

const DEFAULT_TIMEOUT_MS = 3000;

// salt+token MD5 auth, matching the controller's own subsonic.js. Salt is fresh
// per call so one is never reused.
export async function probeSubsonic(args: {
  url: string;
  user: string;
  pass: string;
  timeoutMs?: number;
}): Promise<ProbeResult> {
  const { url, user, pass } = args;
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!url || !user || !pass) {
    return { ok: false, reason: 'missing url, user, or password' };
  }
  try {
    const salt = crypto.randomBytes(8).toString('hex');
    const token = crypto.createHash('md5').update(pass + salt).digest('hex');
    const u = new URL(`${url.replace(/\/$/, '')}/rest/ping.view`);
    u.searchParams.set('u', user);
    u.searchParams.set('t', token);
    u.searchParams.set('s', salt);
    u.searchParams.set('v', '1.16.1');
    u.searchParams.set('c', 'sub-wave-setup');
    u.searchParams.set('f', 'json');

    const res = await fetch(u, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      return { ok: false, reason: `HTTP ${res.status}` };
    }
    const body = await res.json() as {
      ['subsonic-response']?: { status?: string; error?: { code?: number; message?: string } };
    };
    const sr = body['subsonic-response'];
    if (sr?.status === 'ok') {
      return { ok: true };
    }
    const errMsg = sr?.error?.message ?? 'unknown subsonic error';
    return { ok: false, reason: `Navidrome rejected auth: ${errMsg}` };
  } catch (e) {
    return { ok: false, reason: fetchErrorReason(e) };
  }
}

// Also checks `model` is installed, so the wizard can flag it early. The fix is
// `ollama pull <name>`, which we don't run — it's a multi-GB download.
export async function probeOllama(args: {
  url: string;
  model?: string;
  timeoutMs?: number;
}): Promise<ProbeResult> {
  const { url, model } = args;
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!url) return { ok: false, reason: 'no url' };
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/api/tags`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const body = await res.json() as { models?: Array<{ name?: string; model?: string }> };
    const names = (body.models ?? [])
      .map((m) => m.name ?? m.model ?? '')
      .filter(Boolean);
    if (model && !names.some((n) => n === model || n.startsWith(`${model}:`))) {
      return {
        ok: false,
        reason: `Ollama is reachable but model "${model}" isn't installed. Available: ${names.slice(0, 5).join(', ')}${names.length > 5 ? ', …' : ''}`,
      };
    }
    return { ok: true, detail: `${names.length} model${names.length === 1 ? '' : 's'} installed` };
  } catch (e) {
    return { ok: false, reason: fetchErrorReason(e) };
  }
}

// Key validity only — picking a specific model is the admin UI's job.
export async function probeOpenAI(args: {
  apiKey: string;
  baseUrl?: string;        // honoured for OpenAI-compatible reuse
  timeoutMs?: number;
}): Promise<ProbeResult> {
  const { apiKey } = args;
  const baseUrl = args.baseUrl ?? 'https://api.openai.com';
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!apiKey) return { ok: false, reason: 'no api key' };
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401) return { ok: false, reason: '401 — key rejected' };
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const body = await res.json() as { data?: Array<unknown> };
    const n = body.data?.length ?? 0;
    return { ok: true, detail: `${n} model${n === 1 ? '' : 's'} visible` };
  } catch (e) {
    return { ok: false, reason: fetchErrorReason(e) };
  }
}

// Anthropic wants `x-api-key` plus an `anthropic-version` header, not a bearer.
export async function probeAnthropic(args: {
  apiKey: string;
  timeoutMs?: number;
}): Promise<ProbeResult> {
  const { apiKey } = args;
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!apiKey) return { ok: false, reason: 'no api key' };
  try {
    const res = await fetch('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401) return { ok: false, reason: '401 — key rejected' };
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const body = await res.json() as { data?: Array<unknown> };
    const n = body.data?.length ?? 0;
    return { ok: true, detail: `${n} model${n === 1 ? '' : 's'} visible` };
  } catch (e) {
    return { ok: false, reason: fetchErrorReason(e) };
  }
}

// This endpoint answers with or without a key — the key only narrows the list
// to what the account has enabled, so a bad key won't fail the probe.
export async function probeOpenRouter(args: {
  apiKey: string;
  timeoutMs?: number;
}): Promise<ProbeResult> {
  const { apiKey } = args;
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!apiKey) return { ok: false, reason: 'no api key' };
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401) return { ok: false, reason: '401 — key rejected' };
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const body = await res.json() as { data?: Array<unknown> };
    const n = body.data?.length ?? 0;
    return { ok: true, detail: `${n} model${n === 1 ? '' : 's'} visible` };
  } catch (e) {
    return { ok: false, reason: fetchErrorReason(e) };
  }
}

// Unlike OpenRouter, a key is required here, so a bad one surfaces as a 401.
export async function probeRequesty(args: {
  apiKey: string;
  timeoutMs?: number;
}): Promise<ProbeResult> {
  const { apiKey } = args;
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!apiKey) return { ok: false, reason: 'no api key' };
  try {
    const res = await fetch('https://router.requesty.ai/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401) return { ok: false, reason: '401 — key rejected' };
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const body = await res.json() as { data?: Array<unknown> };
    const n = body.data?.length ?? 0;
    return { ok: true, detail: `${n} model${n === 1 ? '' : 's'} visible` };
  } catch (e) {
    return { ok: false, reason: fetchErrorReason(e) };
  }
}

// Same shape as probeRequesty — OrcaRouter is an OpenAI-compatible gateway that
// requires a key, so a bad one surfaces as a 401.
export async function probeOrcarouter(args: {
  apiKey: string;
  timeoutMs?: number;
}): Promise<ProbeResult> {
  const { apiKey } = args;
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!apiKey) return { ok: false, reason: 'no api key' };
  try {
    const res = await fetch('https://api.orcarouter.ai/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401) return { ok: false, reason: '401 — key rejected' };
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const body = await res.json() as { data?: Array<unknown> };
    const n = body.data?.length ?? 0;
    return { ok: true, detail: `${n} model${n === 1 ? '' : 's'} visible` };
  } catch (e) {
    return { ok: false, reason: fetchErrorReason(e) };
  }
}
