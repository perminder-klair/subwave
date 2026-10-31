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
// Ownership is the client name AND the user: the station's own clients are
// `config.navidrome.clientName` and its `-suffix` variants, and only rows of the
// account the station signs in with are touched — never another user's player,
// never another app's, even when the account is a Navidrome admin and the list
// includes them.

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

export function isOwnPlayer(row: NavidromePlayerRow, ctx: OwnershipContext): boolean {
  const name = ctx.clientName.trim();
  if (!name) return false;
  const clientOk = row.client === name || row.client.startsWith(`${name}-`);
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
  /** What the Subsonic ping said the server is, when it answered. */
  server?: ServerIdentity;
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

export function stateOf(players: readonly NavidromePlayerRow[]): RealPathState {
  if (players.length === 0) return 'no-players';
  return players.every(p => p.reportRealPath) ? 'on' : 'off';
}

/** `client [user agent]`, the way the operator finds the row in Navidrome. */
export function playerLabel(p: NavidromePlayerRow): string {
  return p.userAgent ? `${p.client} [${p.userAgent}]` : p.client;
}

const MANUAL_STEP =
  'In Navidrome, open Settings → Players and tick "Report Real Path" on each SUB/WAVE player, '
  + 'or turn on Settings → Music source → "Keep Report Real Path on" here to have the station do it.';

/**
 * The Doctor's finding for the flag. It warns whenever a row is off: without a
 * library mount the tag-built path still weakens the station-archive guard,
 * and with one every local-file play silently falls back to the stream.
 */
export function realPathFinding(
  st: RealPathStatus,
  opts: { localMount: boolean },
): { status: 'ok' | 'warn' | 'skip'; detail: string; hint?: string } {
  switch (st.state) {
    case 'on':
      return { status: 'ok', detail: `on for all ${st.players.length} SUB/WAVE player(s)` };
    case 'no-players':
      return { status: 'skip', detail: 'no SUB/WAVE player registered in Navidrome yet' };
    case 'not-navidrome':
      return { status: 'skip', detail: `a Navidrome setting; the music server is ${serverLabel(st.server)}` };
    case 'unavailable':
      return { status: 'skip', detail: `cannot read Navidrome's players (${st.reason || 'no native API'})` };
    case 'refused':
    case 'off': {
      const off = st.players.filter(p => !p.reportRealPath);
      const what = off.length ? `off for ${off.map(playerLabel).join(', ')}` : 'off';
      const why = opts.localMount
        ? 'MUSIC_LIBRARY_PATH is set, but Navidrome sends tag-built paths, so local-file plays fall back to the stream.'
        : 'Navidrome sends tag-built file paths, not the real ones on disk.';
      return {
        status: 'warn',
        detail: st.state === 'refused' ? `${what} · Navidrome refused to switch it (${st.reason || 'forbidden'})` : what,
        hint: `${why} ${MANUAL_STEP}`,
      };
    }
  }
}
