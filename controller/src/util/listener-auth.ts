// Pure decision logic for Icecast URL-based listener authentication (#478).
//
// Icecast POSTs an application/x-www-form-urlencoded body to the controller's
// /listener-auth endpoint on every listener connect (action=listener_add) and
// disconnect (action=listener_remove). The interesting fields:
//   - user / pass — basic-auth credentials from the listener's URL
//     (https://anything:PASSWORD@host/stream.mp3). One shared password, so
//     the username is ignored.
//   - mount — the requested mount INCLUDING its query string
//     (e.g. /stream.mp3?t=1710000000&auth=PASSWORD). This is how the web
//     player authenticates: browsers can't attach basic auth to an <audio>
//     element, so it rides a ?auth= token instead.
//
// Kept pure (no settings/express imports) so it can be pinned by a unit test
// alongside the other pure helpers.
import { createHash, timingSafeEqual } from 'node:crypto';

// Constant-time string compare that also hides length differences by
// comparing fixed-size digests.
function safeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const da = createHash('sha256').update(a).digest();
  const db = createHash('sha256').update(b).digest();
  return timingSafeEqual(da, db);
}

// Pull the auth token out of a mount string's query, if any.
export function mountAuthToken(mount: string): string {
  const q = mount.indexOf('?');
  if (q === -1) return '';
  try {
    return new URLSearchParams(mount.slice(q + 1)).get('auth') || '';
  } catch {
    return '';
  }
}

export function listenerAuthDecision(opts: {
  enabled: boolean;
  password: string;
  action?: string;
  pass?: string;
  mount?: string;
}): boolean {
  // Disconnect bookkeeping is never denied.
  if (opts.action === 'listener_remove') return true;
  // Auth disabled in settings → allow everything. This also covers the window
  // where the operator has switched auth off but the broadcast container
  // hasn't restarted yet (icecast.xml still carries the auth blocks): the
  // callback keeps firing but the controller waves listeners through.
  if (!opts.enabled) return true;
  // Enabled with no password on file is a broken state (settings validation
  // prevents it) — fail closed rather than open.
  if (!opts.password) return false;
  if (safeEqual(opts.pass || '', opts.password)) return true;
  return safeEqual(mountAuthToken(opts.mount || ''), opts.password);
}

// The web UI's gate. Deliberately NOT listenerAuthDecision: that one fails
// OPEN when stream auth is off, which is right for Icecast (it covers the
// restart window where icecast.xml still has the auth blocks but the setting
// is already off) and catastrophic here — with privatePlayer on and
// listenerAuth off, `enabled` is false and every password would be accepted,
// making the player gate decorative.
//
// So this fails CLOSED: a lock that is on only opens for the real password.
export function stationAuthDecision(opts: {
  privatePlayer: boolean;
  listenerAuth: boolean;
  password: string;
  candidate?: string;
}): boolean {
  // Neither lock engaged — nothing to unlock, so nothing to reject.
  if (!opts.privatePlayer && !opts.listenerAuth) return true;
  // A lock is on but no password is on file (settings validation prevents
  // this) — fail closed rather than hand out the station.
  if (!opts.password) return false;
  return safeEqual(opts.candidate || '', opts.password);
}
