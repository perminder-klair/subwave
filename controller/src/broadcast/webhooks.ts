// Outbound webhooks: station events fanned out to operator-configured HTTP
// endpoints. Fire-and-forget with a hard timeout, no retry and no durable
// outbox; delivery must never block playback. Payload shape is documented in
// routes/webhooks.ts. notify() does not gate events — `track.play` is
// listener-gated at its call site in queue.ts.

import * as settings from '../settings.js';
import { fetchWithTimeout } from '../util/fetch-timeout.js';
import { WEBHOOK_EVENTS, type Webhook, type WebhookEvent } from '../schemas/webhook.js';
export { WEBHOOK_EVENTS, type WebhookEvent };

const TIMEOUT_MS = 5000;

// What a delivery came to. `error` is a short reason built only from the HTTP
// status or a system error code: it is shown to the operator by the Test
// button, and a fetch error's message can carry the hook URL (and any token in
// its query string).
export type DeliveryResult =
  | { ok: true; status: number }
  | { ok: false; status?: number; error: string };

async function postOne(hook: Webhook, body: string): Promise<DeliveryResult> {
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'sub-wave/webhook',
    };
    if (hook.authHeader) headers['Authorization'] = hook.authHeader;
    const r = await fetchWithTimeout(hook.url, {
      method: 'POST',
      headers,
      body,
      timeoutMs: TIMEOUT_MS,
    });
    if (!r.ok) {
      console.warn(`[webhook] ${hook.url} → ${r.status}`);
      return { ok: false, status: r.status, error: `endpoint answered HTTP ${r.status}` };
    }
    return { ok: true, status: r.status };
  } catch (err: any) {
    console.warn(`[webhook] ${hook.url} failed: ${err.message}`);
    return { ok: false, error: deliveryErrorReason(err) };
  }
}

export function deliveryErrorReason(err: any): string {
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
    return `no answer within ${TIMEOUT_MS / 1000}s`;
  }
  const code = err?.cause?.code ?? err?.code;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(code)) {
    return `could not connect (${code})`;
  }
  return 'request failed';
}

// Non-blocking.
export function notify(event: WebhookEvent, payload: Record<string, unknown>) {
  let hooks: Webhook[] = [];
  try {
    hooks = (settings.get()?.webhooks || []) as Webhook[];
  } catch {
    return;
  }
  if (!hooks.length) return;
  const targets = hooks.filter(h => h.enabled && h.events.includes(event));
  if (!targets.length) return;
  const body = JSON.stringify({
    event,
    t: new Date().toISOString(),
    ...payload,
  });
  for (const hook of targets) {
    postOne(hook, body);  // fire-and-forget
  }
}

// Admin "Test" button. Bypasses the event subscription list so a fresh hook can
// be checked before its events are switched on. Unlike notify(), it reports the
// outcome: this button is the operator's only way to confirm a hook works.
export async function fireTest(hook: Webhook): Promise<DeliveryResult> {
  return postOne(hook, JSON.stringify({
    event: 'test',
    t: new Date().toISOString(),
    note: 'sub-wave webhook test fire',
  }));
}
