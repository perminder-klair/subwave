// Checking a Station login before it is saved, and spotting a saved one the
// station has stopped accepting (#1873). The Station login is the HTTP Basic
// Auth pair a reverse proxy may ask for (station-credentials.ts); SUB/WAVE's
// own station password is a separate secret (station-password.ts, #478).
//
// Two things can read a login. A proxy that guards /api refuses a wrong one on
// /api/health with a challenged 401. With no such proxy, the only reader is the
// stream password: Icecast hands the login's password to the controller, the
// same check POST /station-auth runs. The stream itself is never probed, since
// every probe would count a phantom listener, so a proxy that guards only the
// stream goes unseen.

import type { HealthResult } from './api';
import type { StationCredentials } from './station-credentials';
import type { StationAuthResult } from './station-password';

/** Whether a health answer is the station refusing the login: a 401 that
 *  carries a `WWW-Authenticate` challenge, which is how an HTTP Basic Auth
 *  proxy asks for a login. The controller's own 401s never carry one, the
 *  same rule stationAuthResult reads /station-auth by. A 403 is not a refusal:
 *  an IP allowlist, a WAF or a Cloudflare challenge page sends one whatever
 *  the login, and editing the login cannot fix it. A timeout, a network error
 *  or any other status says nothing about the login either, and a 407 comes
 *  from a proxy on the listener's own network. */
export function loginRefused(result: HealthResult): boolean {
  return !result.ok && result.kind === 'http' && result.status === 401 && result.challenged === true;
}

export type LoginCheck =
  /** Nothing that reads the login refused it: save it. */
  | { verdict: 'accepted' }
  /** Refused, so not saved unless saveAnywayOffered. `by` names the check
   *  that refused it. */
  | { verdict: 'rejected'; by: 'proxy' | 'stream-password' }
  /** Not checked: save it only when the listener says "Save anyway". */
  | { verdict: 'unreachable'; rateLimited: boolean };

/** Whether the listener may still save the login after this check. Never
 *  after a proxy's refusal: that proxy reads this very login, and it said no.
 *  After a stream-password refusal, yes: a proxy that guards only the stream
 *  may still want this login, and no check can see that proxy (the stream is
 *  never probed). An unchecked login is the listener's call too. Either way
 *  only an explicit "Save anyway" saves it. */
export function saveAnywayOffered(check: LoginCheck): boolean {
  return check.verdict === 'unreachable' || (check.verdict === 'rejected' && check.by === 'stream-password');
}

const ACCEPTED: LoginCheck = { verdict: 'accepted' };
const UNREACHABLE: LoginCheck = { verdict: 'unreachable', rateLimited: false };

/** Check a Station login with the station before saving it.
 *
 *  1. /api/health with the login. A challenged 401 is a proxy refusing it;
 *     any other failure means it cannot be checked.
 *  2. Health passed, so any proxy in front took the login. With the stream
 *     password off, nothing else reads it.
 *  3. With it on, ask POST /station-auth whether the login's password is the
 *     station password, as verifyStoredPasswords does. Yes: accept.
 *  4. No is a rejection only when no proxy guards /api, because a proxy's
 *     password is not meant to open the station lock. A health check with no
 *     login tells the two apart: refused, a proxy took this login in step 1;
 *     answered, the stream password is the only reader and it said no. */
export async function checkStationLogin(opts: {
  login: StationCredentials;
  /** GET /api/health with this login, or with none. Never throws. */
  health: (login: StationCredentials | null) => Promise<HealthResult>;
  /** Whether /state reports the stream password on; null when unreadable. */
  streamPassword: () => Promise<boolean | null>;
  checkStationAuth: (password: string) => Promise<StationAuthResult>;
}): Promise<LoginCheck> {
  const withLogin = await opts.health(opts.login);
  if (!withLogin.ok) {
    return loginRefused(withLogin) ? { verdict: 'rejected', by: 'proxy' } : UNREACHABLE;
  }

  const locked = await opts.streamPassword();
  if (locked === null) return UNREACHABLE;
  if (!locked) return ACCEPTED;

  const auth = await opts.checkStationAuth(opts.login.password);
  if (auth === 'ok') return ACCEPTED;
  if (auth !== 'denied') return { verdict: 'unreachable', rateLimited: auth === 'rate-limited' };

  const anonymous = await opts.health(null);
  if (loginRefused(anonymous)) return ACCEPTED;
  return anonymous.ok ? { verdict: 'rejected', by: 'stream-password' } : UNREACHABLE;
}
