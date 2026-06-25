// Reachability probes for the setup wizard.
//
// Every probe returns a uniform { ok, reason? } shape so the wizard can
// render the same way regardless of which service is being checked. They
// are deliberately *non-fatal* — the wizard reports the result and lets
// the operator decide whether to retry, continue, or abort. That matches
// real install flows where (a) Navidrome may not be up yet on the same
// host, (b) cloud keys may be added later, (c) Ollama may be on a
// network that isn't reachable from the wizard's perspective.

import crypto from 'node:crypto';
import { fetchErrorReason } from './util.ts';

export interface ProbeResult {
  ok: boolean;
  reason?: string;        // human-readable failure summary, only set when !ok
  detail?: string;        // extra context for ok results (e.g. "32 models")
}

const DEFAULT_TIMEOUT_MS = 3000;

// --- Navidrome / Subsonic ---------------------------------------------------

// Hit GET /rest/ping.view with salt+token MD5 auth — matches the controller's
// own subsonic.js (lines 8–14). Salt is fresh per call so we never reuse one.
//
// Navidrome responds with subsonic-response.status="ok" on auth success, or
// "failed" with a code/message on bad creds.
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

// --- Ollama -----------------------------------------------------------------

// Hit /api/tags to confirm the server is reachable and list installed
// models. Optionally checks that `model` is among them — the wizard
// uses this to flag missing models early (`ollama pull <name>` is the
// usual fix; we don't run it ourselves because it's a multi-GB download).
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

// --- OpenAI -----------------------------------------------------------------

// `GET /v1/models` with bearer auth — accepts the key and returns the
// catalog. We don't validate that any particular model is present; the
// admin UI is where the operator picks a specific model.
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

// --- Anthropic --------------------------------------------------------------

// Anthropic's /v1/models requires the `x-api-key` header and an
// `anthropic-version` header. Returns a paginated list.
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

// --- OpenRouter -------------------------------------------------------------

// OpenRouter's /api/v1/models is happy with or without a key; supplying
// the key just narrows the response to what's enabled for the account.
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

// --- Requesty ---------------------------------------------------------------

// Requesty is an OpenAI-compatible gateway; its /v1/models lists the models
// enabled for the account. A key is required, so a missing/invalid key
// surfaces as a clear 401.
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
