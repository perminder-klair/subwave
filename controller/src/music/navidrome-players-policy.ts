// Which Navidrome player rows are SUB/WAVE's own, and what their "Report Real
// Path" flags mean for the station. Pure: the I/O lives in navidrome-players.ts.
//
// Navidrome answers `getSong`/`search3` with a `path` built from the tags
// (`Artist/Album/01 - Title.flac`) unless the PLAYER making the request has
// "Report Real Path" ticked (Settings → Players). Two things read that path:
// `subsonic.getLocalPath()`, which plays the file off a MUSIC_LIBRARY_PATH
// mount and silently falls back to the stream when the tag-built path is not on
// disk (#1405), and `subsonic.isStationArchive()`, whose path test only matches
// the real `archive/YYYY-MM-DD/HH-00.mp3` layout (#273).
//
// Navidrome keeps one player row per client name + user agent, and a new row
// starts with the flag OFF. So the controller (`node`), the analyzer, Liquidsoap
// (`Lavf`) and the admin connection test (`sub-wave-admin`) each get their own
// row, and a new component or a Navidrome reinstall brings the flag back off
// without the operator noticing. That is why the switch re-applies on a timer
// rather than once.
//
// Ownership is the client name AND the user: the station's own clients are an
// exact list, `config.navidrome.clientName` plus the names its two connection
// tests send, and only rows of the account the station signs in with are touched
// — never another user's player, never another app's, even when the account is a
// Navidrome admin and the list includes them. A prefix or suffix rule would catch
// a third-party app that happens to call itself `sub-wave-of-sound`.

export interface NavidromePlayerRow {
  id: string;
  client: string;
  userAgent: string;
  userName: string;
  reportRealPath: boolean;
  lastSeen: string | null;
}

export interface OwnershipContext {
  /** config.navidrome.clientName, e.g. `sub-wave`. */
  clientName: string;
  /** The account the station signs in with (config.navidrome.user). */
  user: string;
}

/** Coerce one row of Navidrome's `/api/player` answer; null when it is not a player row. */
export function normalizePlayerRow(raw: unknown): NavidromePlayerRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id || typeof r.client !== 'string') return null;
  return {
    id: r.id,
    client: r.client,
    userAgent: typeof r.userAgent === 'string' ? r.userAgent : '',
    userName: typeof r.userName === 'string' ? r.userName : '',
    reportRealPath: r.reportRealPath === true,
    lastSeen: typeof r.lastSeen === 'string' ? r.lastSeen : null,
  };
}

// The client names of the admin connection test (routes/settings/core.ts) and
// the onboarding one (routes/onboarding.ts).
const CONNECTION_TEST_CLIENTS: readonly string[] = ['sub-wave-admin', 'sub-wave-wizard'];

export function isOwnPlayer(row: NavidromePlayerRow, ctx: OwnershipContext): boolean {
  const name = ctx.clientName.trim();
  if (!name) return false;
  const clientOk = row.client === name || CONNECTION_TEST_CLIENTS.includes(row.client);
  // Usernames compare case-insensitively: Navidrome logs in `Radio` as `radio`.
  const userOk = row.userName.toLowerCase() === ctx.user.trim().toLowerCase();
  return clientOk && userOk;
}

export function ownPlayers(rows: readonly NavidromePlayerRow[], ctx: OwnershipContext): NavidromePlayerRow[] {
  return rows.filter(r => isOwnPlayer(r, ctx));
}

/** The outcome of reading (and, when asked, switching) the station's player rows. */
export type RealPathState =
  /** Every SUB/WAVE player row reports real paths. */
  | 'on'
  /** At least one SUB/WAVE row still has the flag off. */
  | 'off'
  /** The opt-in is off and nobody asked, so Navidrome's own API was left alone. */
  | 'not-read'
  /** No SUB/WAVE row exists yet (no request made since Navidrome was set up). */
  | 'no-players'
  /** Navidrome refused the write (a 401/403: the account may not edit players). */
  | 'refused'
  /** The music server says it is not Navidrome: the flag does not exist there. */
  | 'not-navidrome'
  /** No native API to ask: an old Navidrome, a server that does not say what it is, or unreachable. */
  | 'unavailable';

export interface RealPathStatus {
  state: RealPathState;
  players: NavidromePlayerRow[];
  /** Rows this call switched on. */
  switched: string[];
  /** Why the state is `refused` / `unavailable`. */
  reason?: string;
  /**
   * With `unavailable`, when the cause is the account and not an outage:
   * `refused` is Navidrome answering 401/403 to the login or the read,
   * `not-sent` is the station keeping the password back (passwordRefusal).
   */
  access?: 'refused' | 'not-sent';
  /** What the Subsonic ping said the server is, when it answered. */
  server?: ServerIdentity;
}

/** A few of the library's tracks, checked against the MUSIC_LIBRARY_PATH mount. */
export interface LocalPathSample {
  sampled: number;
  /** Paths with no file on the mount proved to be the track: these stream. */
  missed: string[];
  /** Paths inside the mount whose file's size differs from Navidrome's: these play. */
  unproved: string[];
}

export interface ServerIdentity {
  /** The ping's `type` (`navidrome`, `gonic`, …); empty when the server does not say. */
  type: string;
  version: string | null;
}

// SUB/WAVE talks to any Subsonic-compatible server; "Report Real Path" and the
// player rows behind it are Navidrome's own. The Subsonic ping's `type` says
// which server answered (OpenSubsonic servers fill it; older ones leave it
// out). A named server that is not Navidrome is never sent Navidrome's native
// API; a server that does not name itself is tried as before, and its failure
// reads as `unavailable`.
export type ServerKind = 'navidrome' | 'other' | 'unknown';

export function serverKind(type: string | null | undefined): ServerKind {
  const t = String(type ?? '').trim().toLowerCase();
  if (!t || t === 'unknown') return 'unknown';
  return t === 'navidrome' ? 'navidrome' : 'other';
}

/** `gonic 0.16.4`, the way the server named itself. */
export function serverLabel(s: ServerIdentity | undefined): string {
  if (!s?.type) return 'this server';
  return s.version ? `${s.type} ${s.version}` : s.type;
}

// `POST /auth/login` takes the password itself, where every Subsonic call carries
// a salted token. It runs with the opt-in on, or on an operator's press. The guard
// keeps it off the public internet in clear, not off the LAN or the host, so it
// goes over https or to any private host:
// - IPv4 loopback, RFC 1918, link-local and Tailscale's 100.64.0.0/10;
// - IPv6 loopback, unique-local (fc00::/7) and link-local (fe80::/10);
// - `localhost` and a private network's suffixes, `.internal` among them for
//   host.docker.internal, the setup wizard's own default;
// - a single-label name (a compose service).
// `URL` has done the parsing. A numeric host (`0x7f.1`, a decimal) is folded to
// dotted quads, so none passes as a single label. IPv6 stays in its brackets,
// lower-cased, with leading zeros gone, so a first group of `fd12` is the whole
// group and `[fd::1]` (00fd::) can't pass for unique-local.
const PRIVATE_SUFFIXES = [
  '.local', '.localdomain', '.internal', '.lan', '.home', '.home.arpa', '.corp', '.svc', '.fritz.box', '.ts.net',
];

function isLocalHost(host: string): boolean {
  if (host === 'localhost' || PRIVATE_SUFFIXES.some(suffix => host.endsWith(suffix))) return true;
  if (host.startsWith('[')) return host === '[::1]' || /^\[(f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):/.test(host);
  const quad = host.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!quad) return !host.includes('.');
  const [a, b] = [Number(quad[1]), Number(quad[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

/** Why the password may not go to this music server URL; null when it may. */
export function passwordRefusal(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'the password was not sent: the music server URL is not valid';
  }
  if (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && isLocalHost(parsed.hostname))) return null;
  return `the password is only sent over https or to a local address, and ${parsed.protocol}//${parsed.host} is neither`;
}

export function stateOf(players: readonly NavidromePlayerRow[]): RealPathState {
  if (players.length === 0) return 'no-players';
  return players.every(p => p.reportRealPath) ? 'on' : 'off';
}

/** `client [user agent]`, the way the operator finds the row in Navidrome. */
export function playerLabel(p: NavidromePlayerRow): string {
  return p.userAgent ? `${p.client} [${p.userAgent}]` : p.client;
}

const TICK_BY_HAND = 'In Navidrome, open Settings → Players and tick "Report Real Path" on each SUB/WAVE player';
const MANUAL_STEP =
  `${TICK_BY_HAND}, or turn on Settings → Music source → "Keep Report Real Path on" here to have the station do it.`;
const TAG_BUILT_MISS = 'Navidrome sends tag-built paths, so a file whose folders differ from its tags falls back to the stream.';

type RealPathFinding = { status: 'ok' | 'warn' | 'skip'; detail: string; hint?: string };

// Every row on says nothing about the mount. `ok` also needs the sampled tracks
// to be proved: a file existing isn't the right file. The two ways of failing
// are told apart, because one streams the right song and the other plays what's
// on the mount, and a hint saying "stream" over the second would be false.
function mountFinding(flags: string, sample: LocalPathSample | null | undefined): RealPathFinding {
  if (!sample?.sampled) {
    return { status: 'skip', detail: `${flags} · could not sample tracks against MUSIC_LIBRARY_PATH` };
  }
  const notProved = sample.missed.length + sample.unproved.length;
  if (!notProved) {
    return { status: 'ok', detail: `${flags} · ${sample.sampled} of ${sample.sampled} sampled tracks proved on MUSIC_LIBRARY_PATH` };
  }
  const hints: string[] = [];
  if (sample.missed.length) {
    hints.push(`${sample.missed.length} stream instead of playing from disk, for example ${sample.missed[0]}: no file on the mount proved to be the track, by its size and title. `
      + 'Point MUSIC_LIBRARY_PATH at the folder Navidrome scans, or its parent, with the same layout below it. Tracks in a library the mount does not hold stream, as they should.');
  }
  if (sample.unproved.length) {
    hints.push(`${sample.unproved.length} play the file at that path, whose size differs from what Navidrome holds, for example ${sample.unproved[0]}. `
      + 'Rescan Navidrome, and check MUSIC_LIBRARY_PATH holds the library it scans.');
  }
  return {
    status: 'warn',
    detail: `${flags} · ${notProved} of ${sample.sampled} sampled tracks not proved on MUSIC_LIBRARY_PATH`,
    hint: hints.join(' '),
  };
}

/**
 * The Doctor's finding for the flag. With the opt-in off it skips, so an upgrade
 * adds no warning. With it on, a refused or unsent login warns, because the
 * station can neither read the rows nor keep them on; an outage or a missing API
 * skips, with the same step by hand. Otherwise it warns whenever a row is off:
 * without a library mount the tag-built path still weakens the station-archive
 * guard, and with one a file whose folders differ from its tags silently falls
 * back to the stream.
 */
export function realPathFinding(
  st: RealPathStatus,
  opts: { localMount: boolean; sample?: LocalPathSample | null },
): RealPathFinding {
  switch (st.state) {
    case 'on': {
      const flags = `on for all ${st.players.length} SUB/WAVE player(s)`;
      return opts.localMount ? mountFinding(flags, opts.sample) : { status: 'ok', detail: flags };
    }
    case 'not-read':
      return {
        status: 'skip',
        detail: 'not read: "Keep Report Real Path on" is off in Settings → Music source',
        ...(opts.localMount ? { hint: `MUSIC_LIBRARY_PATH is set, and by default ${TAG_BUILT_MISS} Turn the setting on to play those from disk.` } : {}),
      };
    case 'no-players':
      return { status: 'skip', detail: 'no SUB/WAVE player registered in Navidrome yet' };
    case 'not-navidrome':
      return { status: 'skip', detail: `a Navidrome setting; the music server is ${serverLabel(st.server)}` };
    case 'unavailable': {
      const detail = `cannot read Navidrome's players (${st.reason || 'no native API'})`;
      if (st.access === 'refused') {
        return {
          status: 'warn',
          detail,
          hint: `Navidrome refused this account on its own API, so the station can't read or switch its players. ${TICK_BY_HAND}.`,
        };
      }
      if (st.access === 'not-sent') {
        return {
          status: 'warn',
          detail,
          hint: `Point the station at Navidrome over https, or at a private address: a LAN or Tailscale one, a compose service, or host.docker.internal. Until then it can't read or switch its players. ${TICK_BY_HAND}.`,
        };
      }
      return { status: 'skip', detail, hint: `${TICK_BY_HAND}.` };
    }
    case 'refused':
    case 'off': {
      const off = st.players.filter(p => !p.reportRealPath);
      const what = off.length ? `off for ${off.map(playerLabel).join(', ')}` : 'off';
      const why = opts.localMount
        ? `MUSIC_LIBRARY_PATH is set, but ${TAG_BUILT_MISS}`
        : 'Navidrome sends tag-built file paths, not the real ones on disk.';
      return {
        status: 'warn',
        detail: st.state === 'refused' ? `${what} · Navidrome refused to switch it (${st.reason || 'forbidden'})` : what,
        hint: `${why} ${MANUAL_STEP}`,
      };
    }
  }
}
