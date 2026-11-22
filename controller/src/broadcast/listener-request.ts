// The one chokepoint every listener request goes through, whichever door it came
// in by: a typed `POST /request` (all three of its resolution paths, the agent's
// included) or a Grant made on a Hotline Call (`hotline/`). A second copy of any
// of these checks is the bug (root CLAUDE.md, "Policy lives in its own module"),
// so a new way of asking for a track calls these rather than restating them.
//
// What lives here:
//   - the request ledger: requests accepted but not yet resolved, and each
//     IP's last request for the one-pending hold;
//   - admission: the per-IP and station-wide rate limits, the one-pending hold
//     and the `maxPending` cap, in the order `POST /request` always ran them;
//   - the per-track refusals: a clean show holding back an explicit track, and
//     the repeat cooldown;
//   - the push itself, which carries the never-play blocklist and the dedup of
//     a track already queued (#619) inside `queue.push()`.
//
// Admission returns a reason code, never copy: the typed route answers a
// listener with its own lines, and a Call tells the DJ, who says it in persona.
//
// Every function takes the queue as a parameter and this module imports it as
// a type only, like the agent's request path: dj-agent.ts imports this, and a
// static import of queue.js here would load the queue whenever dj-agent loads,
// ahead of the module mocks scripts/handoff-release-wiring.test.ts installs.
type Queue = typeof QueueSingleton;

import type { queue as QueueSingleton } from './queue.js';
import * as settings from '../settings.js';
import { heldBackFromShow } from '../music/explicit-policy.js';
import { stillInFlight } from '../util/request-guard.js';
import {
  checkRateLimit, checkGlobalRateLimit, commitRateLimit, commitGlobalRateLimit,
} from '../middleware/ratelimit.js';

// In-memory request ledger, ephemeral by design: a restart drops in-flight
// requests, and the track is either already queued or it isn't.
export const requests = new Map<string, any>();
const REQUEST_TTL_MS = 10 * 60 * 1000;

// settings.requests.onePendingPerIp: an IP's previous request must resolve AND
// leave the upcoming queue before the next is accepted. pruneRequests() janitors.
const lastByIp = new Map<string, any>();

export function pruneRequests(): void {
  const cutoff = Date.now() - REQUEST_TTL_MS;
  for (const [id, entry] of requests) {
    if (entry.createdAt < cutoff) requests.delete(id);
  }
  for (const [ip, entry] of lastByIp) {
    if (entry.createdAt < cutoff) lastByIp.delete(ip);
  }
}

// Requests accepted but not yet resolved. Their track is not in the upcoming
// queue until it is pushed, which can take the agent's whole timeout, so the
// maxPending gate counts them alongside the queued ones.
export function resolvingRequestCount(): number {
  let n = 0;
  for (const entry of requests.values()) if (entry.status === 'pending') n++;
  return n;
}

// Record the request this IP is now waiting on, for the one-pending hold. The
// entry must carry `pick` once resolved (stillInFlight), and `refused` when
// nothing was queued for this listener.
export function noteRequestFrom(ip: string, entry: any): void {
  lastByIp.set(ip, entry);
}

// Names a listener may not sign a request with: the booth's own roles, the
// station and every persona on the roster (cleanRequesterName matches them on a
// skeleton, so lookalikes are caught too).
export function reservedRequesterNames(): string[] {
  const s = settings.get() as any;
  return [
    'dj', 'admin', 'host', 'mod', 'moderator',
    s?.station || '',
    ...(Array.isArray(s?.personas) ? s.personas.map((p: any) => p?.name || '') : []),
  ];
}

export type AdmissionRefusal = 'cooldown' | 'global-cap' | 'one-pending' | 'queue-full';
export type Admission = { ok: true } | { ok: false; reason: AdmissionRefusal; retryAfter: number };

// The queue-state and rate gates, in the order `POST /request` has always run
// them, spending the hourly budgets only once every gate has passed: those
// later gates reject without queueing, and charging the budgets first burned
// the station-wide cap to zero on rejections alone. The per-IP cooldown is
// spent by checkRateLimit on every attempt, which is the backpressure on
// rejected retries.
export function admitListenerRequest(queue: Queue, ip: string): Admission {
  const cfg = (settings.get() as any)?.requests || {};
  // Janitor runs BEFORE the gates: the one-pending hold refuses without
  // reaching the rest, so pruning later held an IP past the TTL.
  pruneRequests();
  const gate = checkRateLimit(ip);
  if (!gate.ok) return { ok: false, reason: 'cooldown', retryAfter: gate.retryAfter! };
  const globalGate = checkGlobalRateLimit();
  if (!globalGate.ok) return { ok: false, reason: 'global-cap', retryAfter: globalGate.retryAfter! };
  // Both queue-state refusals carry the COOLDOWN as Retry-After: checkRateLimit
  // already stamped it, so the caller genuinely cannot succeed before it expires.
  const retryAfter = Number(cfg.cooldownSec) > 0 ? Number(cfg.cooldownSec) : 60;
  if (cfg.onePendingPerIp !== false && stillInFlight(lastByIp.get(ip), queue.queuedIds())) {
    return { ok: false, reason: 'one-pending', retryAfter };
  }
  // LISTENER requests only — an operator's own studio push carries
  // `requestedBy: 'studio'` for the air-path exemptions and must not consume a
  // slot in the listener queue. See queue.pendingListenerRequests(). Requests
  // still resolving count too: they hold no queue slot yet, so a burst
  // accepted inside one resolution window would otherwise all pass. The brief
  // overlap between a push and its entry settling errs toward refusing.
  const pendingCount = queue.pendingListenerRequests() + resolvingRequestCount();
  if (pendingCount >= (Number(cfg.maxPending) || 6)) {
    return { ok: false, reason: 'queue-full', retryAfter };
  }
  commitRateLimit(ip);
  commitGlobalRateLimit();
  return { ok: true };
}

// A clean show holds a track tagged explicit back from listeners too. Judged on
// the show on air now; an operator's own push does not come through here. Logs
// the refusal so the booth log says why; the caller declines with copy that
// does not leak the reason to a typed request.
export function heldBackForShow(queue: Queue, track: any): boolean {
  const show = settings.resolveActiveShow();
  if (!heldBackFromShow(track, show)) return false;
  queue.log('blocked', `${track?.title} — ${track?.artist} (request held back: tagged explicit, clean show "${show?.name}")`);
  return true;
}

// Repeat cooldown (B6): a track played within `requests.repeatCooldownMin` is
// refused, so a listener can't put the song still ringing in everyone's ears
// straight back on.
export function onRepeatCooldown(queue: Queue, trackId: string | null | undefined): boolean {
  const cdMin = Number((settings.get() as any)?.requests?.repeatCooldownMin ?? 120);
  return !!trackId && cdMin > 0 && queue.recentlyPlayedIds(cdMin / 60).has(trackId);
}

export type ListenerPush = {
  status: 'queued' | 'blocked' | 'already-queued';
  // The intro was a stand-in and the track plays without it, so a caller that
  // records its own copy of the line knows it was never said.
  introDropped: boolean;
};

// Push a listener's track. `queue.push()` carries the never-play blocklist
// (-2) and the dedup of a track a concurrent request already queued (-1, #619);
// this names those outcomes once for every caller.
export async function pushListenerRequest(queue: Queue, args: Parameters<Queue['push']>[0]): Promise<ListenerPush> {
  let introDropped = false;
  const pos = await queue.push({
    ...args,
    onStandInDropped: () => { introDropped = true; args.onStandInDropped?.(); },
  });
  if (pos === -2) return { status: 'blocked', introDropped };
  if (pos === -1) return { status: 'already-queued', introDropped };
  return { status: 'queued', introDropped };
}
