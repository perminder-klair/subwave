// The station-password gate for listener-facing READS (#1575). Deliberately NOT
// requireAdmin: open on a public station (no credential, no counter), FAILS
// CLOSED on a private one. POST /listener-auth's opposite fail-OPEN direction is
// deliberate; never unify the two.
import type { NextFunction, Request, Response } from 'express';
import * as settings from '../settings.js';
import { stationAuthCandidate, stationAuthDecision, stationLockEngaged } from '../util/listener-auth.js';
import { checkAuthRateLimit, clientIp, peekAuthRateLimit } from './ratelimit.js';

// Two deliberate differences from POST /station-auth's use of the same limiter:
// only FAILURES are counted (this is a read an agent may poll), and they land in
// this route's OWN bucket, so a stale-password integration cannot spend the
// attempts a human on that address needs to unlock the player.
//
// Counting failures alone means the bucket must be read BEFORE the password is
// compared: a full bucket answers 429 without comparing, so the correct
// password is refused too until the window drains. Read only after a mismatch,
// the cap would change what a wrong guess returns and never stop the guessing.
function tooManyAttempts(res: Response, retryAfter: unknown) {
  res.setHeader('Retry-After', String(retryAfter));
  return res.status(429).json({ error: 'too many attempts' });
}

export async function requireStationAuth(req: Request, res: Response, next: NextFunction) {
  await settings.load();
  const s = settings.get();
  const privatePlayer = s?.privacy?.privatePlayer === true;
  const listenerAuth = s?.privacy?.listenerAuth === true;

  // A public station has nothing to guess, so it never reads the counter —
  // failures left over from when it was private must not shut a public read.
  const ip = clientIp(req);
  if (stationLockEngaged({ privatePlayer, listenerAuth })) {
    const peek = peekAuthRateLimit(ip, 'station-read');
    if (!peek.ok) return tooManyAttempts(res, peek.retryAfter);
  }

  const ok = stationAuthDecision({
    privatePlayer,
    listenerAuth,
    password: s?.privacy?.password || '',
    candidate: stationAuthCandidate({
      headerToken: req.headers['x-station-auth'],
      authorization: req.headers.authorization,
      query: (req.query as Record<string, unknown> | undefined)?.auth,
    }),
  });
  if (ok) return next();

  const gate = checkAuthRateLimit(ip, 'station-read');
  if (!gate.ok) return tooManyAttempts(res, gate.retryAfter);
  return res.status(401).json({
    error:
      'station password required — this station is private. Send it as an ' +
      'x-station-auth header (preferred), an Authorization: Bearer token, or ' +
      'an ?auth= query param (logged by proxies — a header is safer).',
  });
}
