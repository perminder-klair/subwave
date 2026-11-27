// Short-lived signed links for admin media the browser fetches without the
// console's Basic header (an <audio> element, a download it navigates to).
// The link carries its own proof: an HMAC over a scope, a subject and an
// expiry, keyed by a per-process secret, never derived from ADMIN_PASS. A
// restart voids every link, like the device cookie in middleware/auth.ts.
// The scope keeps one feature's link from opening another's route: a preview
// signature over track `abc` is not a download signature over `abc`.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const SECRET = randomBytes(32);

export function signLink(scope: string, subject: string, expSec: number): string {
  return createHmac('sha256', SECRET).update(`${scope}:${subject}:${expSec}`).digest('base64url');
}

// `?exp=<unix seconds>&sig=<base64url>` for a link that lapses `ttlSec` from now.
export function signedQuery(scope: string, subject: string, ttlSec: number, nowMs = Date.now()): string {
  const exp = Math.floor(nowMs / 1000) + ttlSec;
  return `exp=${exp}&sig=${signLink(scope, subject, exp)}`;
}

// `exp` and `sig` straight from the query string: anything but one well-formed
// pair that matches and has not lapsed is refused.
export function signedLinkValid(
  scope: string, subject: string, exp: unknown, sig: unknown, nowMs = Date.now(),
): boolean {
  if (typeof exp !== 'string' || typeof sig !== 'string' || !/^\d{1,12}$/.test(exp)) return false;
  const expSec = Number(exp);
  if (expSec * 1000 <= nowMs) return false;
  const want = Buffer.from(signLink(scope, subject, expSec));
  const got = Buffer.from(sig);
  return got.length === want.length && timingSafeEqual(got, want);
}
