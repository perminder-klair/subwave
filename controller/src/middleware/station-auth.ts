// The station-password gate for listener-facing READS (#1575).
//
// Deliberately NOT requireAdmin: an operator's call-in agent is a listener-side
// consumer, not an admin console, so it must work on a public station with no
// credentials at all — and must stop dead on a private one. That is exactly
// stationAuthDecision's contract, and this middleware is the only thing that
// wraps it for a GET:
//
//   - Neither privacy lock engaged  → open, no credential needed, no counter
//     touched. A public station's API is public.
//   - A lock engaged                → FAILS CLOSED. A missing, blank or wrong
//     password is 401, and a lock with no password on file is 401 too.
//
// The opposite failure direction lives one file over in POST /listener-auth,
// which fails OPEN on purpose (it covers the window where icecast.xml still
// carries the auth blocks but the setting is already off). The two must never
// be "unified" — see the root CLAUDE.md gate rule.
import type { NextFunction, Request, Response } from 'express';
import * as settings from '../settings.js';
import { stationAuthCandidate, stationAuthDecision } from '../util/listener-auth.js';
import { checkAuthRateLimit, clientIp } from './ratelimit.js';

// Two deliberate differences from POST /station-auth's use of the same limiter.
//
// Only FAILURES are counted. That endpoint is a password box a human pokes a
// handful of times; this one is a read an agent may poll, and charging correct
// calls to a 20-per-15-min ceiling would throttle the authorised caller this
// route exists for. Counting failures alone keeps the brute-force bound
// without inventing a new oracle: a wrong password already answers "no", and
// 429-instead-of-401 says nothing 401 didn't.
//
// And they are counted in this route's OWN bucket, not the password box's. The
// ceiling is per (surface, ip), so an operator's call-in agent left polling
// with a stale password spends its own twenty attempts and never the ones a
// HUMAN on that address needs to unlock the player. A misconfigured
// integration must not be able to lock a listener out of the station.
export async function requireStationAuth(req: Request, res: Response, next: NextFunction) {
  await settings.load();
  const s = settings.get();
  const ok = stationAuthDecision({
    privatePlayer: s?.privacy?.privatePlayer === true,
    listenerAuth: s?.privacy?.listenerAuth === true,
    password: s?.privacy?.password || '',
    candidate: stationAuthCandidate({
      headerToken: req.headers['x-station-auth'],
      authorization: req.headers.authorization,
      query: (req.query as Record<string, unknown> | undefined)?.auth,
    }),
  });
  if (ok) return next();

  const gate = checkAuthRateLimit(clientIp(req), 'station-read');
  if (!gate.ok) {
    res.setHeader('Retry-After', String(gate.retryAfter));
    return res.status(429).json({ error: 'too many attempts' });
  }
  return res.status(401).json({
    error:
      'station password required — this station is private. Send it as an ' +
      'x-station-auth header (preferred), an Authorization: Bearer token, or ' +
      'an ?auth= query param (logged by proxies — a header is safer).',
  });
}
