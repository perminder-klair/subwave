// Spotify Web API client — the ONLY module that speaks HTTP to Spotify.
//
// Two responsibilities, kept deliberately narrow: (1) OAuth — refresh the
// access token from a stored refresh token, exchange an authorization code once,
// build the authorize URL; (2) a thin `api()` over the REST surface the catalog
// source and the playback controller need. Nothing here knows about songs,
// queues or the mixer; it returns Spotify's own JSON shapes.
//
// `fetch` and the clock are INJECTED so every path is unit-testable without a
// Spotify account (scripts/spotify-client.test.ts). Credentials come from a
// getter (env / state/secrets.env) and are never logged: every log line carries
// the endpoint and the status, never a header or a body.
//
// Retry posture is deliberately mild, per CLAUDE.md's "don't add aggressive
// retry": one token refresh on 401, one bounded wait on 429, nothing else. A
// failure surfaces as SpotifyApiError and the caller decides.
//
// RATE LIMITING IS SHARED STATE, and that is the load-bearing part. Spotify
// meters a rolling 30-second window, and this station is stuck in Development
// Mode for good (extended quota is organisations-only, ≥250k MAU), so the
// window is not something we can buy our way out of — see docs/spotify-source.md.
// A 429 therefore sets ONE gate that every other caller reads, instead of each
// caller discovering the limit by spending a request against it. The measured
// failure: the per-artist genre fill hit a long `Retry-After`, every worker
// independently retried, and the old code — which only waited when Retry-After
// fitted inside its cap and otherwise fell straight through to the throw —
// spun through ~2000 remaining artists as fast as it could, turning a rate
// limit into a rate-limit storm. Never restore per-request-only 429 handling.
//
// FOUR LANES, and the rule they encode is: the gate slows down what the
// station can afford to lose, and NEVER what keeps it on air.
//   • CRITICAL (`critical: true`) — the Spotify Connect player calls. Bypasses
//     the gate entirely: attempted however long the window, never spaced.
//   • OPERATOR (`operator: true`) — one request a human just pressed a button
//     for. Bypasses the gate too, because a diagnostic you cannot run during an
//     outage is a diagnostic you do not have (CLAUDE.md: manual operator
//     triggers are exempt from every automatic gate). Deliberately narrow —
//     never a walk, never a pick path.
//   • FOREGROUND (default) — catalogue reads, walking the pool. Waits out a
//     short window, gives up on a long one, and is never spaced.
//   • BACKGROUND (`background: true`) — droppable enrichment. Spaced by a
//     global promise chain, and while the gate is closed it does not send a
//     request AT ALL. That is what turns 2000 doomed calls into zero.
//
// AN EXEMPT LANE MAY NOT ARM THE GATE. This is the other half of the exemption
// and it was missing, at the cost of a full day of the station being locked
// out. A hold is a DEADLINE, set once by a refusal that arrived while the gate
// was OPEN — never moved by one that arrived while it was already shut. The old
// code recomputed `now + Retry-After` on every 429 and kept it whenever it was
// later, which with a constant header is always: each refusal slid the wall a
// full window further out. Since `critical` bypasses the gate, a track every
// few minutes was re-arming a 3706-second hold roughly every hundred seconds,
// and it was persisted on every slide, so restarting restored it and the first
// play() re-armed it. Nothing non-critical ran for eight hours. See
// noteRateLimited — `wasGated` is what enforces this.
//
// CRITICAL exists because the first version of this gate did not have it, and a
// 1800s window meant THIRTY MINUTES OF GUARANTEED SILENCE: play() resolves the
// device before every command, getDevices() was foreground, so every play died
// before reaching the network. Making the player calls obey the gate looks like
// a consistency fix and is the opposite of one. The transport already owns
// exactly the backoff the gate was trying to provide — a 3s hard floor between
// commands plus a 30s→10min exponential hold (transport.ts) — and a play is ONE
// request per track, perhaps seven across a whole window. Denying it protects
// nothing measurable and only stops the station recovering early when Spotify's
// Retry-After was conservative.
//
// Background is deliberately NOT put on the same queue as foreground: a line of
// spaced enrichment requests sitting in front of a play command is exactly the
// priority inversion this split exists to prevent.
//
// THE GATE IS REACTIVE; THE PACER IS PROACTIVE. The gate above only ever learns
// about a limit by being refused by one, which means every window costs a 429
// to discover. The pacer is the other half: a rolling-30-second ceiling on
// non-critical request STARTS, so a burst never reaches Spotify in the first
// place. It replaced the background-only `backgroundGapMs` spacing, which left
// the FOREGROUND lane — the catalogue walk, ~100 back-to-back requests on a
// 5000-track pool — completely unspaced, and that walk is the likeliest thing
// tipping a window.
//
// The ceiling is ADAPTIVE, and it has to be: Spotify publishes no number for
// Development Mode on either the rate-limit or the quota-modes page, and since
// 2026-07-23 the budget is counted PER DEVELOPER ACCOUNT and shared with every
// other app that account owns — so no constant compiled in here can be right.
// It halves on a 429 and eases back over clean windows, which converges on
// whatever the real limit is today, alongside whatever else is spending it.
//
// The pacer COUNTS every lane but SLOWS only two. Exempting critical from being
// counted while letting its refusals halve the ceiling made the loop read a
// signal it could not act on: four player 429s took the ceiling 90 → 45 → 22 →
// 11 → 10 and pinned it there, throttling exactly the catalogue traffic that
// was not causing the problem.
//
// A 429 NOW COMES IN TWO KINDS and they must not be conflated. Since July 2026
// a quota-exhaustion 429 carries `{"reason": "QUOTA_EXCEEDED"}`; an ordinary
// rolling-window 429 does not. The first is a budget and clears on Spotify's
// schedule, the second clears in seconds — so they get different maximum holds
// and the operator is told which one they are sitting out. MAX_GATE_MS was
// sized for a rolling window and is simply the wrong bound for a budget.
//
// AND THE HOLD IS PERSISTED, through injected sinks (hold-file.ts) rather than
// filesystem calls here — this module still only speaks HTTP. Without it a
// restart forgot the window and walked the catalogue straight back into it.
//
// THIS CLIENT TARGETS THE POST-FEBRUARY-2026 WEB API. Spotify removed a large
// slice of the surface for Development Mode apps (enforced on existing apps
// 2026-03-09); a removed route answers 403 with no useful body, which reads as
// a permissions problem and is not one. What that costs us, so nobody
// "restores" one of them:
//   • GET /playlists/{id}/tracks → /playlists/{id}/items, and the row's `track`
//     key is now `item` (map.ts:unwrapItem absorbs both). Page size max 50.
//   • the batch reads (GET /tracks?ids, /albums?ids, /artists?ids) are gone —
//     fetch by id, one at a time.
//   • GET /artists/{id}/top-tracks is gone with NO replacement, which is why
//     spotify declares hasTopSongs:false.
//   • /search caps `limit` at 10 (was 50) — callers wanting more must page.
//   • /me no longer reports `product` or `country`, so Premium is unprobeable.
//   • `available_markets` and GET /markets are gone and nothing can derive a
//     market any more, so the legacy `market=from_token` is not sent at all.
//     The user token's own country applies server-side.
// Extended-quota apps are exempt from all of it, but that needs Spotify's
// commercial approval and is not something a station can count on.

import type { SpotifyHold, SpotifyHoldKind } from './hold-file.js';

export const SPOTIFY_ACCOUNTS = 'https://accounts.spotify.com';
export const SPOTIFY_API = 'https://api.spotify.com/v1';

// Spotify's own caps, named because both this module and its callers page
// against them. Passing more than the cap is not clamped politely: the server
// trims the page, and `paginate` reads a short page as the last one.
export const SPOTIFY_PAGE_MAX = 50;
export const SPOTIFY_SEARCH_MAX = 10;

// Scopes the station needs. `streaming` is for librespot's login (the Connect
// receiver), the player scopes for commanding it, the rest for the catalog.
// `user-read-private` no longer buys `product` on /me (February 2026 removed
// the field) but stays in the list: dropping it would force every connected
// operator through the consent screen again for nothing.
export const SPOTIFY_SCOPES = [
  'streaming',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-library-read',
] as const;

export interface SpotifyCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface SpotifyClientDeps {
  fetch?: typeof fetch;
  now?: () => number;
  credentials: () => SpotifyCredentials;
  // Spotify MAY rotate the refresh token on refresh; the caller persists it.
  onRefreshToken?: (token: string) => void | Promise<void>;
  // Fresh access tokens are also handed out so librespot's first login can use
  // one (state/spotify/token) — see docker/spotify/librespot-run.sh.
  onAccessToken?: (token: string, expiresAt: number) => void | Promise<void>;
  log?: (line: string) => void;
  // Longest a FOREGROUND call will sit waiting for the rate-limit gate before
  // giving up (ms). Bounded so a transition never stalls behind Spotify's
  // limiter — the transport's own backoff is the better place to lose time.
  // Background calls never wait at all.
  maxRetryAfterMs?: number;
  // Minimum gap between BACKGROUND request starts (ms). The politeness floor
  // that keeps a wide enrichment pool from becoming a burst. The pacer bounds
  // the total rate; this still bounds how tightly the drip itself bunches.
  backgroundGapMs?: number;
  // The pacer's ceiling for NON-CRITICAL requests per rolling 30s window, read
  // fresh on every request so an operator's edit applies without a restart.
  // A starting point that the adaptive halving moves down and back up.
  requestsPer30s?: () => number;
  // The persisted hold, read once at construction and written whenever the gate
  // extends. Injected so this module keeps no filesystem edge and the tests can
  // drive a "restart" without one (hold-file.ts is the production wiring).
  loadHold?: () => SpotifyHold | null;
  saveHold?: (hold: SpotifyHold) => void;
  // Remove the persisted hold — the operator's escape hatch.
  clearHold?: () => void;
  // Injected sleep, so the tests do not spend real seconds proving the waits.
  sleep?: (ms: number) => Promise<void>;
}

export class SpotifyApiError extends Error {
  // How long Spotify said to wait, when it said so. Carried on the error so a
  // caller can report the window instead of guessing from a log line.
  public retryAfterMs?: number;
  constructor(public readonly status: number, message: string, public readonly endpoint: string) {
    super(message);
    this.name = 'SpotifyApiError';
  }
}

// Thrown when the shared gate is closed and the caller was not willing to wait
// it out. Distinct from a 429 that came back from Spotify: NO request was sent,
// which is the whole point — a rate-limited station must stop asking.
export class SpotifyRateLimitError extends SpotifyApiError {
  public readonly kind: SpotifyHoldKind;
  // The KIND is named, because the two refusals want opposite reactions from a
  // reader. "rate limit" means wait a moment; "quota" means the developer
  // account's budget is spent and no amount of retrying will help. This message
  // is what the admin's Test button and the doctor's connectivity finding print
  // verbatim, and calling an exhausted account budget a "rate limit" sent an
  // operator looking for a 30-second window that was actually over an hour.
  constructor(endpoint: string, retryAfterMs: number, kind: SpotifyHoldKind = 'rate-limit') {
    super(
      429,
      `${endpoint} skipped — Spotify ${kind === 'quota' ? "developer-account quota exhausted" : 'rate limit'}, ${Math.ceil(retryAfterMs / 1000)}s left`,
      endpoint,
    );
    this.name = 'SpotifyRateLimitError';
    this.retryAfterMs = retryAfterMs;
    this.kind = kind;
  }
}

export class SpotifyAuthError extends SpotifyApiError {
  constructor(status: number, message: string) {
    super(status, message, 'token');
    this.name = 'SpotifyAuthError';
  }
}

interface TokenState {
  accessToken: string;
  expiresAt: number; // ms epoch
}

// Strip anything that looks like a bearer/refresh token from free text before
// it reaches a log line. Spotify tokens are long base62/urlsafe strings.
export function redactSpotify(text: string): string {
  return String(text ?? '')
    .replace(/(access_token|refresh_token|Authorization|Bearer|code)(["'=:\s]+)[A-Za-z0-9._~+/=-]{16,}/gi, '$1$2[redacted]')
    .replace(/[A-Za-z0-9_-]{100,}/g, '[redacted]');
}

// A page size Spotify will actually honour. Asking beyond the cap is worse than
// it looks: the server trims the page and `paginate` reads a short page as the
// last one, so an over-asked walk silently stops after its first page.
export function clampPage(n: unknown, max = SPOTIFY_PAGE_MAX): number {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v > 0 ? Math.min(v, max) : max;
}

// Default politeness floor between background request starts. 150ms ≈ 6/s ≈ 200
// per rolling 30s window, comfortably under a Development Mode app's budget
// while still filling a few thousand artists over a handful of pool builds.
export const DEFAULT_BACKGROUND_GAP_MS = 150;

// Spotify sends `Retry-After` in SECONDS. A 429 without one is still a 429, so
// assume a window rather than treating it as "retry immediately" — guessing low
// here is what keeps a limit alive.
const FALLBACK_RETRY_AFTER_MS = 5_000;
// Never trust a pathological header into a multi-hour hold; the gate is advisory
// and the next build can ask again. This bound is for the ROLLING WINDOW, which
// is a seconds-to-minutes thing.
const MAX_GATE_MS = 30 * 60_000;
// A QUOTA_EXCEEDED hold is a budget, not a window, and Spotify clears it on its
// own schedule. Clamping it to the rolling-window bound would have the station
// asking again half an hour into a refusal that has hours left to run — which
// is how a quota exhaustion renews itself. Still bounded, because a hold we
// cannot clear by waiting is worse than one we re-earn.
const MAX_QUOTA_GATE_MS = 6 * 60 * 60_000;
// The longest hold worth carrying ACROSS A RESTART. A restart is an operator
// asking for the station back; honouring a multi-hour deadline written by an
// earlier process — which is exactly what the sliding-hold bug produced — makes
// that impossible. Anything longer is treated as corruption and probed instead.
export const MAX_RESTORED_HOLD_MS = 30 * 60_000;
// A quota 429 with no Retry-After. Guessing five seconds here (the rolling
// window's fallback) would put the station straight back into the refusal.
const FALLBACK_QUOTA_RETRY_AFTER_MS = 30 * 60_000;

// The pacer's window. Spotify's own unit — "a rolling 30 second window".
export const RATE_WINDOW_MS = 30_000;
// Default ceiling when no setting is supplied. Deliberately conservative: no
// number is published, so being wrong low costs a slower catalogue walk while
// being wrong high costs a 429 and a halving.
export const DEFAULT_REQUESTS_PER_30S = 90;
// The ceiling never halves below this. A station that cannot make a handful of
// catalogue requests per window cannot build a pool at all, and at that point
// the honest failure is Spotify's 429, not our own throttle.
export const MIN_REQUESTS_PER_30S = 10;
// How much of the configured ceiling a clean window buys back. Slow on purpose:
// climbing quickly is how the halving gets undone before the real limit has
// been felt.
const CEILING_RECOVERY = 1.1;

export interface RequestOpts {
  method?: 'GET' | 'PUT' | 'POST' | 'DELETE';
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  // 404 on player endpoints means "no active device" — callers often want
  // null rather than a throw for that.
  allow404?: boolean;
  // Droppable enrichment rather than something the station needs to keep
  // playing. Spaced by the global gap, and abandoned outright — without
  // reaching the network — while the rate-limit gate is closed.
  background?: boolean;
  // The opposite end: a call the station cannot stay on air without. Skips the
  // gate entirely — see the three-lane note at the top of this file.
  critical?: boolean;
  // An explicit OPERATOR action — a button they pressed and are watching. Skips
  // the gate, because the repo rule is that manual triggers are exempt from
  // every automatic gate, and because a diagnostic the operator cannot run
  // during an outage is a diagnostic they do not have. Deliberately narrow: one
  // request they asked for, never a walk. Like `critical` it bypasses the gate,
  // and like `critical` its refusal must not arm one — it asked while held.
  operator?: boolean;
}

export class SpotifyClient {
  private token: TokenState | null = null;
  private refreshing: Promise<string> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly maxRetryAfterMs: number;
  private readonly backgroundGapMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  // The shared gate: ms-epoch until which Spotify has told us to stop asking.
  private limitedUntil = 0;
  // Which refusal earned the current hold. A rolling window and an exhausted
  // account budget need different waits and different operator wording.
  private limitKind: SpotifyHoldKind = 'rate-limit';
  private limitEndpoint = '';
  // The window we have already logged, so a flood of callers hitting one limit
  // produces ONE line instead of one per request.
  private limitLogged = 0;
  // The last time a PLAYER command was refused, and how. Reported to the
  // operator but never acted on: the critical lane is exempt from the gate, so
  // letting its refusals arm one is a feedback loop (see noteRateLimited).
  private lastCriticalRefusalAt = 0;
  private lastCriticalRefusalKind: SpotifyHoldKind = 'rate-limit';
  // Start times of recent NON-CRITICAL requests, pruned to the rolling window.
  private readonly recentStarts: number[] = [];
  // The pacer's live ceiling — the configured value, halved by each 429 and
  // eased back over clean windows. 0 until the first request reads the setting.
  private ceiling = 0;
  private lastPenaltyAt = 0;
  private lastRecoveryAt = 0;
  // Serialises background request STARTS, spacing them by backgroundGapMs.
  // Foreground deliberately bypasses this queue (see the header note).
  private bgGate: Promise<void> = Promise.resolve();
  private bgLastStart = 0;

  constructor(private readonly deps: SpotifyClientDeps) {
    this.fetchImpl = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
    this.maxRetryAfterMs = deps.maxRetryAfterMs ?? 10_000;
    this.backgroundGapMs = deps.backgroundGapMs ?? DEFAULT_BACKGROUND_GAP_MS;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    // A hold that outlived the last process. Restoring it is the whole point:
    // a restart is when the pool rebuild happens, so forgetting the window is
    // how a station walks the catalogue straight back into it.
    const held = deps.loadHold?.();
    const leftOver = held ? held.until - this.now() : 0;
    if (held && leftOver > 0) {
      // A hold no operator can outlast is a bug, not a policy. The sliding-hold
      // defect wrote deadlines that kept marching ahead of the clock, and a
      // station that boots into one of those can never recover on its own — so
      // an implausible one is treated as the corruption it is. Losing a genuine
      // long hold costs one refused probe; honouring a corrupt one costs hours.
      if (leftOver > MAX_RESTORED_HOLD_MS) {
        this.log(`[spotify] ignoring a saved hold of ${Math.round(leftOver / 60_000)} minutes — longer than any window this station should honour across a restart. Asking once to find out where we really stand.`);
        deps.clearHold?.();
      } else {
        this.limitedUntil = held.until;
        this.limitKind = held.kind;
        this.limitEndpoint = held.endpoint ?? '';
        // Logged, not silent: an operator restarting to "fix" a quiet station
        // needs to know it is deliberately not asking, and for how long.
        this.log(`[spotify] resuming a ${held.kind === 'quota' ? 'quota' : 'rate-limit'} hold from before the restart — ${Math.ceil(leftOver / 1000)}s left`);
      }
    }
  }

  // ── rate-limit gate ────────────────────────────────────────────────────────

  // How long Spotify has told us to wait, 0 when clear. Callers use this to
  // stand down (the genre fill) and the admin/doctor to say so out loud.
  rateLimitedForMs(): number {
    return Math.max(0, this.limitedUntil - this.now());
  }

  // What the current hold IS, for the admin card and the doctor. `msLeft` 0
  // means no hold; `kind` still names the last one, which is what lets the
  // operator surface say "quota, cleared 4 minutes ago" rather than nothing.
  rateLimitHold(): { msLeft: number; kind: SpotifyHoldKind; endpoint: string; until: number } {
    return { msLeft: this.rateLimitedForMs(), kind: this.limitKind, endpoint: this.limitEndpoint, until: this.limitedUntil };
  }

  // The pacer's live ceiling and how much of the current window is spent —
  // reported so a slow catalogue walk reads as pacing rather than as a fault.
  pacerState(): { ceiling: number; usedInWindow: number; configured: number } {
    this.prunePacerWindow();
    // Recovery is applied when the ceiling is READ, which is the only moment it
    // means anything — so a station that has been quiet for an hour reports (and
    // uses) a recovered ceiling rather than the floor it was left at.
    this.recoverPacer();
    return { ceiling: this.ceiling || this.configuredCeiling(), usedInWindow: this.recentStarts.length, configured: this.configuredCeiling() };
  }

  // Record a 429. Only ever EXTENDS the window — a later, shorter header must
  // not shorten a hold another response already earned. A QUOTA_EXCEEDED
  // refusal outranks a rolling-window one for the same reason: it is the
  // stricter statement, and downgrading the label would have the operator
  // reading an account budget as a thirty-second blip.
  // Record a 429.
  //
  // A HOLD IS A DEADLINE, SET ONCE PER EPISODE. It is never moved by a refusal
  // that arrived while the gate was already shut, and this is the single most
  // important line in the file.
  //
  // The measured failure: this used to compute `until = now + retryAfter` on
  // every 429 and take it whenever it was later than the current deadline. With
  // a constant Retry-After that is ALWAYS later — the clock has moved on — so
  // each refusal slid the wall a full window further out and the hold could
  // only count down during an interval in which nothing was refused. The
  // `critical` lane guarantees no such interval exists: it bypasses the gate so
  // music keeps playing (which is right), so with a track every few minutes it
  // was re-arming a 3706-second hold roughly every hundred seconds. The station
  // sat locked out for a whole day, restarts included, because the hold was
  // also being written to disk on every slide.
  //
  // `wasGated` is therefore load-bearing: only a request that was ALLOWED to
  // ask may say when to stop asking. If Spotify genuinely needs longer than the
  // deadline we recorded, the gate opens, one probe goes out, is refused, and
  // opens a NEW episode — self-correcting at a cost of exactly one request.
  private noteRateLimited(
    retryAfterMs: number,
    endpoint: string,
    kind: SpotifyHoldKind,
    opts: { wasGated: boolean; critical: boolean },
  ): number {
    // A critical refusal is REPORTED but never arms the gate. The lane is
    // exempt from the gate by design; leaving it able to arm one is a feedback
    // loop, not a safety net — and it is the loop above.
    if (opts.critical) {
      this.lastCriticalRefusalAt = this.now();
      this.lastCriticalRefusalKind = kind;
      if (this.rateLimitedForMs() === 0) {
        this.log(`[spotify] a player command was refused (${endpoint}, ${kind}). Playback commands are never gated, so this is reported rather than acted on; catalogue work is unaffected.`);
      }
      return this.rateLimitedForMs();
    }
    // A refusal received while we were supposed to be waiting teaches us
    // nothing new about when to stop waiting.
    if (!opts.wasGated) return this.rateLimitedForMs();

    const cap = kind === 'quota' ? MAX_QUOTA_GATE_MS : MAX_GATE_MS;
    this.limitedUntil = this.now() + Math.min(retryAfterMs, cap);
    this.limitEndpoint = endpoint;
    // The kind must be able to DOWNGRADE. This used to reduce to a no-op for
    // 'rate-limit', so once a quota hold had been seen the label was quota for
    // the life of the process and on disk — carrying the six-hour cap and the
    // account-budget wording into ordinary thirty-second windows.
    this.limitKind = kind;
    this.deps.saveHold?.({ until: this.limitedUntil, kind, endpoint, at: this.now() });
    // Only a gated lane's refusal is evidence the ceiling was too high: the
    // pacer cannot slow the critical lane, so penalising it for one is pure
    // loss (see `pace`).
    this.penalisePacer();
    const left = this.rateLimitedForMs();
    if (this.limitedUntil > this.limitLogged) {
      this.limitLogged = this.limitedUntil;
      this.log(kind === 'quota'
        ? `[spotify] the developer account's Web API QUOTA is exhausted (${endpoint}) — holding catalogue requests for ${Math.ceil(left / 1000)}s. This budget is shared by every app on the account; it is not the 30-second rate limit. Playback is unaffected.`
        : `[spotify] rate limited on ${endpoint} — holding catalogue requests for ${Math.ceil(left / 1000)}s`);
    }
    return left;
  }

  // Drop the hold entirely, on disk as well as in memory. The operator's way
  // out: before this existed there was none — no route, no button, and even
  // disconnecting Spotify left the hold in place, because the client is a
  // process singleton and `resetToken()` clears only the access token.
  clearHold(): void {
    const had = this.rateLimitedForMs();
    this.limitedUntil = 0;
    this.limitLogged = 0;
    this.deps.clearHold?.();
    if (had > 0) this.log(`[spotify] rate-limit hold cleared by the operator (${Math.ceil(had / 1000)}s remained)`);
  }

  // ── pacer ──────────────────────────────────────────────────────────────────

  private configuredCeiling(): number {
    const n = Math.floor(Number(this.deps.requestsPer30s?.() ?? DEFAULT_REQUESTS_PER_30S));
    return Number.isFinite(n) && n > 0 ? Math.max(MIN_REQUESTS_PER_30S, n) : DEFAULT_REQUESTS_PER_30S;
  }

  private prunePacerWindow(): void {
    const cutoff = this.now() - RATE_WINDOW_MS;
    while (this.recentStarts.length && this.recentStarts[0] <= cutoff) this.recentStarts.shift();
  }

  private penalisePacer(): void {
    const configured = this.configuredCeiling();
    const from = this.ceiling || configured;
    this.ceiling = Math.max(MIN_REQUESTS_PER_30S, Math.floor(from / 2));
    this.lastPenaltyAt = this.now();
  }

  // Ease back after a window with no refusal, at most once per window. Also the
  // one place a settings edit lands: the configured value is re-read every time,
  // so lowering it applies at once while raising it is still climbed into.
  private recoverPacer(): void {
    const configured = this.configuredCeiling();
    if (!this.ceiling) { this.ceiling = configured; return; }
    if (this.ceiling > configured) { this.ceiling = configured; return; }
    if (this.ceiling >= configured) return;
    const t = this.now();
    // Recover for EVERY clean window that has passed, not one per call.
    //
    // This used to advance a single step and only when a non-critical request
    // happened to be made — so after a long hold, during which by definition no
    // such request is made, the ceiling sat at its floor of 10 and then climbed
    // at +1 per window, needing ~80 requests to get back to 90. The recovery
    // was throttled by exactly the traffic the throttle was suppressing. Making
    // it a function of elapsed time means a quiet hour recovers in one step,
    // which is what "the limit has not bitten in an hour" should mean.
    const since = Math.max(this.lastPenaltyAt, this.lastRecoveryAt);
    const windows = Math.floor((t - since) / RATE_WINDOW_MS);
    if (windows <= 0) return;
    this.lastRecoveryAt = since + windows * RATE_WINDOW_MS;
    for (let i = 1; i < windows && this.ceiling < configured; i++) {
      this.ceiling = Math.max(this.ceiling + 1, Math.round(this.ceiling * CEILING_RECOVERY));
    }
    // Rounded, not ceil'd: 50 * 1.1 is 55.000000000000007 in binary floating
    // point, and a ceil there quietly makes every step one larger than the
    // policy says. `+1` is the floor, so a small ceiling still climbs.
    this.ceiling = Math.min(configured, Math.max(this.ceiling + 1, Math.round(this.ceiling * CEILING_RECOVERY)));
  }

  // Wait until this request fits under the ceiling, then claim its slot.
  //
  // The two lanes are treated differently ON PURPOSE. Background is droppable
  // enrichment already sitting on a serialised chain, so it waits however long
  // the ceiling says — that is the drip working. Foreground is a catalogue read
  // something is waiting on, so it waits only as long as it would wait out one
  // of Spotify's own short windows and then goes anyway: the pacer is OUR guess
  // at a limit Spotify does not publish, and holding an operator's search for
  // half a minute on a guess is worse than spending the request and letting the
  // real 429 gate answer. Critical never reaches here at all.
  private async pace(opts: RequestOpts): Promise<void> {
    // Critical is never paced (music must not wait) and an operator press is
    // never paced (they are watching). Both are still COUNTED, below: a ceiling
    // that ignores traffic it cannot slow is a control loop reading the wrong
    // signal, and it used to be halved by critical refusals while never seeing
    // a critical request — so it fell to its floor and stayed there.
    if (opts.critical || opts.operator) {
      this.prunePacerWindow();
      this.recentStarts.push(this.now());
      return;
    }
    this.recoverPacer();
    // Bounded, because the pacer is ADVISORY and the caller is not. An injected
    // sleep that does not advance the clock (tests) or a clock that does not
    // move would otherwise spin here forever; letting the request through after
    // a few attempts costs at most a 429, which the gate already handles, while
    // hanging the caller costs the station a pick.
    for (let attempt = 0; attempt < 8; attempt++) {
      this.prunePacerWindow();
      if (this.recentStarts.length < this.ceiling) break;
      const wait = this.recentStarts[0] + RATE_WINDOW_MS - this.now();
      if (wait <= 0) continue;
      if (!opts.background && wait > this.maxRetryAfterMs) break;
      await this.sleep(wait + Math.floor(Math.random() * 100));
    }
    this.recentStarts.push(this.now());
  }

  // Spotify's Retry-After is in SECONDS. A present-and-numeric header is taken
  // at face value including 0, which means "you may retry now" — inventing a
  // window there would hold the station off for no reason. Only a missing or
  // unparseable header falls back, and it falls back to a real wait: a 429 is
  // still a 429, and guessing low is how a limit stays alive.
  private retryAfterFrom(res: { headers: { get(k: string): string | null } }, fallbackMs = FALLBACK_RETRY_AFTER_MS): number {
    const raw = res.headers.get('retry-after');
    const n = Number(raw);
    return raw != null && raw !== '' && Number.isFinite(n) && n >= 0 ? n * 1000 : fallbackMs;
  }

  // Which refusal this 429 is. Since 2026-07-23 an exhausted DEVELOPER ACCOUNT
  // quota answers `{"reason": "QUOTA_EXCEEDED"}` while a rolling-window refusal
  // does not, and the two want very different waits. The body is read by the
  // caller and passed in, because a Response body may be read only once and the
  // error path below needs the same text.
  private kindOf429(body: string): SpotifyHoldKind {
    try {
      const j: any = JSON.parse(body || '{}');
      const reason = String(j?.reason ?? j?.error?.reason ?? '');
      if (reason.toUpperCase() === 'QUOTA_EXCEEDED') return 'quota';
    } catch { /* not JSON — an unlabelled 429 is the rolling window */ }
    return 'rate-limit';
  }

  // Space background starts on one chain, so a wide pool stays polite.
  private throttleBackground<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.bgGate.then(async () => {
      const wait = this.bgLastStart + this.backgroundGapMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.bgLastStart = this.now();
      return fn();
    });
    // Keep the chain alive past failures — a rejected link would poison every
    // queued caller behind it (music/musicbrainz.ts learned this first).
    this.bgGate = run.then(() => undefined, () => undefined);
    return run;
  }

  // ── OAuth ──────────────────────────────────────────────────────────────────

  static authorizeUrl(opts: { clientId: string; redirectUri: string; state: string; scopes?: readonly string[] }): string {
    const u = new URL(`${SPOTIFY_ACCOUNTS}/authorize`);
    u.searchParams.set('client_id', opts.clientId);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('redirect_uri', opts.redirectUri);
    u.searchParams.set('scope', (opts.scopes ?? SPOTIFY_SCOPES).join(' '));
    u.searchParams.set('state', opts.state);
    // Force the consent screen so a re-connect can add scopes.
    u.searchParams.set('show_dialog', 'true');
    return u.toString();
  }

  // One-time: authorization code → { refreshToken, accessToken, expiresIn }.
  static async exchangeCode(
    opts: { clientId: string; clientSecret: string; code: string; redirectUri: string },
    fetchImpl: typeof fetch = fetch,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; scope: string }> {
    const res = await fetchImpl(`${SPOTIFY_ACCOUNTS}/api/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: opts.code, redirect_uri: opts.redirectUri }),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token || !j.refresh_token) {
      throw new SpotifyAuthError(res.status, `code exchange failed: ${j.error_description || j.error || res.status}`);
    }
    return { accessToken: j.access_token, refreshToken: j.refresh_token, expiresIn: Number(j.expires_in) || 3600, scope: String(j.scope || '') };
  }

  hasCredentials(): boolean {
    const c = this.deps.credentials();
    return Boolean(c.clientId && c.clientSecret && c.refreshToken);
  }

  // Drop the cached access token so the next call refreshes. Needed whenever the
  // refresh token changes underneath us (a reconnect that added scopes, a pasted
  // token, a disconnect): an access token lives an hour and carries the scopes
  // it was minted with, so without this a reconnect looked like it had not
  // happened until the old token expired.
  resetToken(): void {
    this.token = null;
  }

  // A valid access token, refreshing when absent or within 60s of expiry.
  // Concurrent callers share one in-flight refresh.
  async accessToken(force = false): Promise<string> {
    if (!force && this.token && this.token.expiresAt - this.now() > 60_000) return this.token.accessToken;
    if (!this.refreshing) {
      this.refreshing = this.refresh().finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }

  private async refresh(): Promise<string> {
    const c = this.deps.credentials();
    if (!c.clientId || !c.clientSecret || !c.refreshToken) {
      throw new SpotifyAuthError(0, 'Spotify is not connected — SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET and SPOTIFY_REFRESH_TOKEN are required');
    }
    const res = await this.fetchImpl(`${SPOTIFY_ACCOUNTS}/api/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: c.refreshToken }),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) {
      this.log(`[spotify] token refresh failed: ${res.status} ${redactSpotify(String(j.error_description || j.error || ''))}`);
      throw new SpotifyAuthError(res.status, `token refresh failed (${res.status}): ${j.error_description || j.error || 'no access_token'}`);
    }
    const expiresAt = this.now() + (Number(j.expires_in) || 3600) * 1000;
    this.token = { accessToken: j.access_token, expiresAt };
    if (j.refresh_token && j.refresh_token !== c.refreshToken) await this.deps.onRefreshToken?.(j.refresh_token);
    await this.deps.onAccessToken?.(j.access_token, expiresAt);
    this.log(`[spotify] token refreshed (expires in ${Math.round((expiresAt - this.now()) / 1000)}s)`);
    return j.access_token;
  }

  // ── REST ───────────────────────────────────────────────────────────────────

  async api<T = any>(path: string, opts: RequestOpts = {}): Promise<T | null> {
    const url = new URL(path.startsWith('http') ? path : `${SPOTIFY_API}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const endpoint = `${opts.method ?? 'GET'} ${url.pathname}`;
    return opts.background
      ? this.throttleBackground(() => this.send<T>(url, endpoint, opts))
      : this.send<T>(url, endpoint, opts);
  }

  private async send<T>(url: URL, endpoint: string, opts: RequestOpts): Promise<T | null> {
    // The gate, consulted BEFORE the network. A caller that asks anyway is how
    // a rate limit renews itself — except for the two lanes that must ask.
    const exempt = opts.critical || opts.operator;
    const gateMs = this.rateLimitedForMs();
    const held = exempt ? 0 : gateMs;
    // May this request's refusal set the deadline? Only if the gate was OPEN
    // when it was sent — see noteRateLimited. Asking anyway (the exempt lanes)
    // and being refused says nothing new about when to stop waiting. Waiting a
    // short window out earns the same right as finding the gate open.
    let allowedToAsk = gateMs === 0;
    if (held > 0) {
      // Background work is droppable by definition: stand down, cost nothing.
      if (opts.background) throw new SpotifyRateLimitError(endpoint, held, this.limitKind);
      // Foreground waits out a SHORT window — a track boundary can afford a few
      // seconds — and gives up on a long one so the caller's own backoff takes
      // over rather than the seam hanging.
      if (held > this.maxRetryAfterMs) throw new SpotifyRateLimitError(endpoint, held, this.limitKind);
      // Jitter, so a fleet released by one header does not stampede back in
      // sync (llm/internal/core/retry.ts keeps it for the same reason).
      await this.sleep(held + Math.floor(Math.random() * 200));
      // It waited the window out, so it is asking with permission.
      allowedToAsk = true;
    }

    // Then the pacer: the gate above only knows about limits Spotify has
    // already refused us for, this is what keeps a burst from earning one.
    await this.pace(opts);

    const attempt = async (token: string) => this.fetchImpl(url.toString(), {
      method: opts.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

    let res = await attempt(await this.accessToken());
    if (res.status === 401) {
      // Exactly one refresh-and-retry: a second 401 is a real auth problem.
      res = await attempt(await this.accessToken(true));
    }
    // The 429 body, read here because a Response body may be read ONCE and both
    // the kind check and the error message below want it. Cleared whenever a
    // fresh response replaces the one it came from, so the error path can never
    // print the previous attempt's body.
    let bodyText: string | null = null;
    const note429 = (r: Response, body: string) => {
      const kind = this.kindOf429(body);
      return this.noteRateLimited(
        this.retryAfterFrom(r, kind === 'quota' ? FALLBACK_QUOTA_RETRY_AFTER_MS : FALLBACK_RETRY_AFTER_MS),
        endpoint,
        kind,
        { wasGated: allowedToAsk, critical: !!opts.critical },
      );
    };
    if (res.status === 429) {
      // Publish the window to every other caller FIRST — that is what stops the
      // storm — then decide whether this one call can afford to wait it out.
      bodyText = await res.text().catch(() => '');
      const left = note429(res, bodyText);
      // `left <= max` includes 0 — a Retry-After of 0 is a licence to retry at
      // once, not a reason to skip the retry.
      //
      // The exempt lanes never retry here. `left` is the GATE's remaining time,
      // and their refusals deliberately no longer arm it, so it reads 0 and
      // would make every player 429 retry immediately — doubling the player's
      // request rate during exactly the outage that caused it. The transport
      // owns that backoff (a 3s floor plus 30s→10min), and an operator press is
      // one request they can repeat themselves.
      if (!opts.background && !opts.critical && !opts.operator && left <= this.maxRetryAfterMs) {
        await this.sleep(left + Math.floor(Math.random() * 200));
        res = await attempt(await this.accessToken());
        bodyText = null;
        if (res.status === 429) {
          bodyText = await res.text().catch(() => '');
          note429(res, bodyText);
        }
      }
    }
    if (res.status === 204) return null;
    if (res.status === 404 && opts.allow404) return null;
    if (!res.ok) {
      // Read the body ONCE, as text, then try to shape it. A removed endpoint
      // answers 403 with no `error.message` at all — falling straight through
      // to `statusText` printed a bare "Forbidden" that named nothing and cost
      // an afternoon, so the raw prefix goes in the line too.
      const raw = bodyText != null ? bodyText : await res.text().catch(() => '');
      let j: any = {};
      try { j = raw ? JSON.parse(raw) : {}; } catch { /* not JSON — the prefix is all we get */ }
      const msg = j?.error?.message || j?.error_description || j?.error || res.statusText || `HTTP ${res.status}`;
      const body = raw.trim().slice(0, 300);
      const detail = body && !String(msg).includes(body) ? ` · body: ${redactSpotify(body)}` : '';
      // A 429 has already been logged ONCE by noteRateLimited, for the window
      // rather than the request. Logging it again here is precisely the flood.
      if (res.status !== 429) this.log(`[spotify] ${endpoint} → ${res.status} ${redactSpotify(String(msg))}${detail}`);
      const err = new SpotifyApiError(res.status, `${endpoint} failed (${res.status}): ${msg}`, endpoint);
      if (res.status === 429) err.retryAfterMs = this.rateLimitedForMs();
      throw err;
    }
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : null;
  }

  // ── catalog ────────────────────────────────────────────────────────────────

  // `limit` caps at SPOTIFY_SEARCH_MAX (10) since February 2026 — a caller
  // wanting 25 pages through `offset`, it does not ask for 25.
  search(q: string, types: Array<'track' | 'artist' | 'album' | 'playlist'>, opts: { limit?: number; offset?: number } = {}) {
    return this.api('/search', { query: { q, type: types.join(','), limit: clampPage(opts.limit, SPOTIFY_SEARCH_MAX), offset: opts.offset ?? 0 } });
  }
  getTrack(id: string) { return this.api(`/tracks/${encodeURIComponent(id)}`, { allow404: true }); }
  // `background` marks the pool's genre fill: droppable, spaced, and abandoned
  // without a request while the rate-limit gate is closed. The batch read this
  // replaced is gone, so this is the highest-volume call the station makes.
  getArtist(id: string, opts: { background?: boolean } = {}) {
    return this.api(`/artists/${encodeURIComponent(id)}`, { allow404: true, background: opts.background });
  }
  getArtistAlbums(id: string, opts: { limit?: number; offset?: number; includeGroups?: string } = {}) {
    return this.api(`/artists/${encodeURIComponent(id)}/albums`, { query: { limit: clampPage(opts.limit ?? 20), offset: opts.offset ?? 0, include_groups: opts.includeGroups ?? 'album,single' } });
  }
  getAlbum(id: string) { return this.api(`/albums/${encodeURIComponent(id)}`, { allow404: true }); }
  getAlbumTracks(id: string, opts: { limit?: number; offset?: number } = {}) {
    return this.api(`/albums/${encodeURIComponent(id)}/tracks`, { query: { limit: clampPage(opts.limit), offset: opts.offset ?? 0 } });
  }
  getMyPlaylists(opts: { limit?: number; offset?: number } = {}) { return this.api('/me/playlists', { query: { limit: clampPage(opts.limit), offset: opts.offset ?? 0 } }); }
  getPlaylist(id: string) { return this.api(`/playlists/${encodeURIComponent(id)}`, { query: { fields: 'id,name,description,owner(display_name),items(total),images' }, allow404: true }); }
  // /items, not /tracks: the old route was removed and now 403s. Contents come
  // back only for playlists the connected account owns or collaborates on —
  // anything else answers metadata with an empty page, not an error.
  getPlaylistItems(id: string, opts: { limit?: number; offset?: number } = {}) {
    return this.api(`/playlists/${encodeURIComponent(id)}/items`, { query: { limit: clampPage(opts.limit), offset: opts.offset ?? 0, additional_types: 'track' } });
  }
  getSavedTracks(opts: { limit?: number; offset?: number } = {}) { return this.api('/me/tracks', { query: { limit: clampPage(opts.limit), offset: opts.offset ?? 0 } }); }
  getSavedAlbums(opts: { limit?: number; offset?: number } = {}) { return this.api('/me/albums', { query: { limit: clampPage(opts.limit), offset: opts.offset ?? 0 } }); }
  // `operator: true` is passed by the admin's Test button only — one request
  // the operator explicitly asked for, which must answer even during a hold.
  // The doctor's periodic connectivity probe deliberately does NOT pass it.
  getMe(opts: { operator?: boolean } = {}) { return this.api('/me', { operator: opts.operator }); }

  // Walk a paginated endpoint: `page(offset)` returns Spotify's paging object.
  async *paginate<T>(page: (offset: number) => Promise<any>, opts: { pageSize?: number; max?: number } = {}): AsyncGenerator<T> {
    const size = opts.pageSize ?? 50;
    let offset = 0;
    let seen = 0;
    while (true) {
      const p = await page(offset);
      const items: T[] = Array.isArray(p?.items) ? p.items : [];
      for (const it of items) {
        yield it;
        if (opts.max && ++seen >= opts.max) return;
      }
      if (!p?.next || items.length === 0 || items.length < size) return;
      offset += items.length;
    }
  }

  // ── player (Spotify Connect) ───────────────────────────────────────────────
  //
  // EVERY call here is `critical`, and that is the whole block's defining
  // property: these are what keep the station on air, so they skip the
  // rate-limit gate rather than being denied by it. Low volume by construction
  // (one command per track, behind the transport's 3s floor and exponential
  // hold), so they cost the quota almost nothing — while blocking them costs the
  // whole window in dead air. Do not "tidy" the flag away.

  getDevices() { return this.api('/me/player/devices', { critical: true }); }
  getPlaybackState() { return this.api('/me/player', { query: { additional_types: 'track' }, allow404: true, critical: true }); }
  play(opts: { deviceId?: string; uris?: string[]; contextUri?: string; positionMs?: number } = {}) {
    const body: Record<string, unknown> = {};
    if (opts.uris) body.uris = opts.uris;
    if (opts.contextUri) body.context_uri = opts.contextUri;
    if (opts.positionMs != null) body.position_ms = opts.positionMs;
    return this.api('/me/player/play', { method: 'PUT', query: { device_id: opts.deviceId }, body: Object.keys(body).length ? body : undefined, critical: true });
  }
  pause(deviceId?: string) { return this.api('/me/player/pause', { method: 'PUT', query: { device_id: deviceId }, allow404: true, critical: true }); }
  queue(uri: string, deviceId?: string) { return this.api('/me/player/queue', { method: 'POST', query: { uri, device_id: deviceId }, critical: true }); }
  transfer(deviceId: string, play = false) { return this.api('/me/player', { method: 'PUT', body: { device_ids: [deviceId], play }, critical: true }); }
  seek(positionMs: number, deviceId?: string) { return this.api('/me/player/seek', { method: 'PUT', query: { position_ms: Math.max(0, Math.round(positionMs)), device_id: deviceId }, critical: true }); }
}
