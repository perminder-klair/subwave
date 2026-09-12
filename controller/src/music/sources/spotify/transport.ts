// SpotifyTransport — the queue's PlaybackTransport in spotify mode. Owns the
// SEQUENCE the spec describes: the queue hands over pick B → at A's seam the
// controller commands B on the receiver → librespot reports track_changed →
// the mixer is told (telnet spotify_track, a real boundary + metadata) → the
// existing now-playing.json path fires onTrackStarted, airs the link over B's
// intro, scrobbles, runs the next pick. Nothing above the mixer changes.
//
// Three rules from CLAUDE.md shape it:
//   • the station must keep making sound — no pick by the seam means a random
//     pool track (the auto.m3u analogue), and a stopped/paused feed is restarted
//     after `idleMs`;
//   • policy lives in pure modules — every decision is seam-pure.ts, this file
//     is IO and wiring;
//   • degrade silently — every marker/telnet/API failure logs once and the tick
//     tries again; nothing here throws into the queue.
//
// Dependencies are injected for scripts/spotify-transport.test.ts; the
// production wiring is `startSpotifyTransportIfActive()` at the bottom.

import type { QueueItem } from '../../../broadcast/queue/types.js';
import type { PlaybackTransport } from '../../../broadcast/queue/transport.js';
import type { SpotifyPlayerEvent, SpotifyAudioState } from '../../../broadcast/spotify-player-pure.js';
import {
  applyEvent, seamDecision, mismatchAction, mixerMetadataFor, remainingMs,
  DEFAULT_START_TIMEOUT_MS, DEFAULT_IDLE_MS,
  type CurrentTrack, type MismatchPolicy,
} from './seam-pure.js';
import { strace, straceThrottled } from './trace.js';

export interface TransportDeps {
  // player commands
  play: (trackId: string) => Promise<{ ok: true } | { ok: false; reason: string; message: string }>;
  transferHere: (play: boolean) => Promise<boolean>;
  // One-shot truth at boot: what the account is playing right now and whether
  // it is on OUR receiver. Seeds `current` so a controller restart mid-song
  // neither re-commands the song nor trusts a stale marker (measured: a marker
  // from before a receiver restart read as "playing, duration unknown" and the
  // transport held forever).
  playbackState?: () => Promise<{ trackId: string; positionMs: number; durationMs: number | null; playing: boolean; onReceiver: boolean } | null>;
  // mixer (telnet)
  mixerTrack: (meta: Record<string, string>) => Promise<{ lagSec: number } | null>;
  mixerGap: (on: boolean) => Promise<boolean>;
  // markers: the event FEED (every event since a seq, in order) and the
  // silence detector's state. `readPlayerEvent` (the latest-marker read) is
  // kept as a fallback for a mixer image whose event script predates the feed.
  readEvents?: (afterSeq: number) => SpotifyPlayerEvent[];
  readPlayerEvent: () => SpotifyPlayerEvent | null;
  readAudioState: () => SpotifyAudioState | null;
  // catalog
  songById: (id: string) => Promise<any | null>;
  fallbackSong: () => Promise<any | null>;
  // The same recording on another release, or null. ONE metered search, and the
  // implementation declines outright while the rate-limit gate is shut — a
  // substitute is optional and must never add delay to the seam (source.ts).
  findAlternative: (want: any) => Promise<any | null>;
  // The refused-track memory: remember the id and take it out of the live pool.
  // Injected rather than imported so the transport keeps no store edge and the
  // tests can watch it.
  noteRefused: (trackId: string, info: { title: string; artist: string; reason: string }) => void;
  isRefused: (trackId: string) => boolean;
  // queue hooks
  onUnplayable: (item: QueueItem, reason: string) => void;
  // Point a queue item at a different recording of the same song. The item
  // object is NOT replaced — `pending`/`expected` identity checks hold — only
  // its track, so now-playing, the scrobble and the mixer metadata name what
  // actually played.
  onTrackSubstituted: (item: QueueItem, track: any) => void;
  log: (kind: string, line: string) => void;
  // settings
  seamLeadMs: () => number;
  mismatchPolicy: () => MismatchPolicy;
  now?: () => number;
  startTimeoutMs?: number;
  idleMs?: number;
}

const MIN_COMMAND_GAP_MS = 3_000;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 10 * 60_000;
const SILENT_ENDS_TRACK_MS = 15_000;
// An intentional gap that outlives this is not intentional any more (the next
// track failed to start): drop the gate so the dead-air guard airs the
// emergency loop instead of the silence measured on the first run's hold.
const GAP_MAX_MS = 20_000;

interface Expected {
  id: string;
  item: QueueItem | null; // null = a pool fallback the queue never saw
  // The pool song a fallback command chose — what the mixer is told when it
  // starts, so now-playing names the track that is actually playing.
  song: any | null;
  commandedAt: number;
  attempts: number;
}

export class SpotifyTransport implements PlaybackTransport {
  readonly id = 'spotify';
  private pending: QueueItem | null = null;
  private expected: Expected | null = null;
  private current: CurrentTrack | null = null;
  private lastEventAt = 0;
  private lastSeq = 0;
  private durationAsked: string | null = null;
  // Failure backoff + a hard floor between play commands. Measured on the first
  // real run: without them a receiver that could not load audio was commanded
  // ~100 tracks in a few minutes, Spotify rate-limited the session (429s, then
  // audio-key errors on EVERY track) and the loop fed itself.
  private failStreak = 0;
  private holdUntil = 0;
  private silentSince: number | null = null;
  private lastCommandAt: number | null = null;
  private reclaimAttempts = 0;
  private gapOn = false;
  private gapSince = 0;
  private busy = false;
  private timer: NodeJS.Timeout | null = null;
  private lastLog = new Map<string, number>();
  // Queue items that have already spent their one alternative-release search.
  // A WeakSet rather than a flag on QueueItem: the cap is a property of this
  // transport's handling, not of the queue's data, and an item that airs or is
  // cancelled should take its entry with it.
  private readonly altTried = new WeakSet<QueueItem>();
  // "The last command is dead — do not sit out the idle window for it."
  //
  // seamDecision treats `current === null` as "we commanded something, give the
  // player a moment", bounded by `idleMs` (15s). That is right when a command is
  // genuinely in flight, and wrong after a refusal, where we KNOW nothing is
  // coming. Without this a substitute sat in `pending` for the full idle window
  // with the emergency loop on air. Consumed by the next tick that actually
  // reaches a decision, so a failure backoff still holds it.
  private resumeNow = false;
  private readonly now: () => number;

  constructor(private readonly deps: TransportDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(intervalMs = 500): void {
    if (this.timer) return;
    // Skip the feed's history: everything before this boot has already been
    // acted on (or belongs to a receiver that no longer exists).
    const history = this.deps.readEvents?.(0) ?? [];
    for (const ev of history) if (ev.seq != null && ev.seq > this.lastSeq) this.lastSeq = ev.seq;
    const latest = this.deps.readPlayerEvent();
    if (latest) this.lastEventAt = Math.max(this.lastEventAt, latest.at);
    void this.bootstrap();
    this.timer = setInterval(() => { void this.tick(); }, intervalMs);
    (this.timer as any).unref?.();
    this.deps.log('scheduler', 'Spotify transport started — picks play on the Spotify Connect receiver');
  }

  private async bootstrap(): Promise<void> {
    if (!this.deps.playbackState) return;
    try {
      const st = await this.deps.playbackState();
      if (st?.onReceiver && st.playing) {
        this.current = { id: st.trackId, durationMs: st.durationMs, positionMs: st.positionMs, positionAt: this.now(), playing: true, ended: false };
        this.deps.log('scheduler', `Spotify transport: receiver already playing ${st.trackId} — resuming the clock from ${Math.round(st.positionMs / 1000)}s`);
      } else {
        this.current = null; // nothing of ours is playing; the idle rule starts something
      }
    } catch (err: any) {
      this.logOnce('bootstrap', 'error', `Spotify transport: playback-state bootstrap failed: ${err?.message ?? err}`);
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ── PlaybackTransport ────────────────────────────────────────────────────

  async handoff(item: QueueItem): Promise<void> {
    // Never accept a track we already know Spotify refuses. keep() keeps these
    // out of every pick path, so reaching here means the agent named an id from
    // its own conversation memory that no tool returned — the one route the
    // source-level filter cannot cover. Refusing it now costs nothing; letting
    // it through costs a play command, a start timeout and a dead slot.
    const id = item.track?.id;
    if (id && this.deps.isRefused(id)) {
      this.deps.log('scheduler', `Spotify: "${item.track?.title ?? id}" was refused by Spotify before — not queueing it again`);
      strace('handoff', `declined known-refused ${id}`, { id, title: item.track?.title });
      this.deps.onUnplayable(item, 'known unavailable');
      return;
    }
    if (this.pending && this.pending !== item) {
      this.deps.log('scheduler', `Spotify transport: "${this.pending.track?.title}" replaced by "${item.track?.title}" before it aired`);
    }
    this.pending = item;
    // Nothing on air (boot, or the previous track ended while no pick was
    // ready): start it now rather than waiting for the tick's idle window.
    if (!this.expected && (!this.current || this.current.ended)) await this.tick(true);
  }

  async skip(): Promise<boolean> {
    if (this.busy) return false;
    this.deps.log('scheduler', 'Spotify transport: operator skip — commanding the next track now');
    await this.commandNext('operator skip');
    return true;
  }

  status(): Record<string, unknown> {
    const now = this.now();
    return {
      transport: 'spotify',
      current: this.current ? { id: this.current.id, playing: this.current.playing, ended: this.current.ended, remainingMs: remainingMs(this.current, now) } : null,
      awaitingStart: this.expected ? { id: this.expected.id, forMs: now - this.expected.commandedAt } : null,
      pending: this.pending ? { id: this.pending.track?.id ?? null, title: this.pending.track?.title ?? null } : null,
      gap: this.gapOn,
      failStreak: this.failStreak,
      holdForMs: this.holdUntil > now ? this.holdUntil - now : 0,
      lastEventAgoMs: this.lastEventAt ? now - this.lastEventAt : null,
      audio: this.deps.readAudioState(),
    };
  }

  // ── the tick ─────────────────────────────────────────────────────────────

  async tick(immediate = false): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      // 1. Fold every new player event, in order. The feed is authoritative;
      //    the single latest-marker read only covers an older mixer image.
      const batch = this.deps.readEvents?.(this.lastSeq) ?? [];
      if (batch.length) {
        for (const ev of batch) {
          this.lastSeq = ev.seq ?? this.lastSeq;
          this.lastEventAt = Math.max(this.lastEventAt, ev.at);
          await this.handleEvent(ev);
        }
      } else if (!this.deps.readEvents || this.lastSeq === 0) {
        const ev = this.deps.readPlayerEvent();
        if (ev && ev.at > this.lastEventAt && (ev.seq == null || ev.seq > this.lastSeq)) {
          this.lastEventAt = ev.at;
          if (ev.seq != null) this.lastSeq = ev.seq;
          await this.handleEvent(ev);
        }
      }
      // 1b. A track whose start we saw without a duration (a `playing` with no
      //     preceding `track_changed`, or a boot seed): ask the catalog once, or
      //     the seam clock never fires.
      if (this.current && this.current.durationMs == null && !this.current.ended && this.durationAsked !== this.current.id) {
        this.durationAsked = this.current.id;
        const song = await this.deps.songById(this.current.id).catch(() => null);
        const sec = Number(song?.duration);
        if (this.current && Number.isFinite(sec) && sec > 0) this.current = { ...this.current, durationMs: Math.round(sec * 1000) };
      }
      // 1c. A receiver that restarted mid-track emits no end_of_track; the only
      //     sign is silence on the bus while we still believe it is playing.
      //     blank.detect's marker is the witness; 15 s of it ends the track.
      const audio = this.deps.readAudioState();
      if (audio?.state === 'silent') {
        this.silentSince ??= audio.atMs;
        if (this.current?.playing && !this.current.ended && this.now() - this.silentSince > SILENT_ENDS_TRACK_MS) {
          this.deps.log('scheduler', `Spotify transport: feed silent for ${Math.round((this.now() - this.silentSince) / 1000)}s while "${this.current.id}" should be playing — treating it as ended`);
          this.current = { ...this.current, playing: false, ended: true };
        }
      } else {
        this.silentSince = null;
      }
      // 1d. A gap declared long ago with nothing started is dead air, not a seam.
      if (this.gapOn && !this.expected && this.now() - this.gapSince > GAP_MAX_MS) {
        this.deps.log('scheduler', 'Spotify transport: nothing started within the gap window — handing the air to the dead-air guard');
        await this.setGap(false);
      }
      // 2. Decide about the seam — unless a failure backoff holds it.
      const now = this.now();
      if (now < this.holdUntil) {
        this.busy = false;
        return;
      }
      // Consumed here rather than at the top of the tick: an early return on the
      // failure backoff must not spend it.
      const resume = this.resumeNow;
      this.resumeNow = false;
      const d = seamDecision({
        now,
        current: this.current,
        awaitingStart: !!this.expected,
        commandedAt: this.expected?.commandedAt ?? null,
        hasPending: !!this.pending,
        seamLeadMs: this.deps.seamLeadMs(),
        lastCommandAt: this.lastCommandAt,
        startTimeoutMs: this.deps.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
        idleMs: (immediate || resume) ? 0 : (this.deps.idleMs ?? DEFAULT_IDLE_MS),
      });
      // Twice a second, so keyed on the decision itself: straceThrottled prints
      // a change immediately and otherwise heartbeats, instead of ~172,000
      // identical lines a day burying everything else in the container log.
      straceThrottled('seam', `${d.action}:${this.expected?.id ?? this.pending?.track?.id ?? ''}`,
        `seam ${d.action} — ${d.reason}`,
        { action: d.action, reason: d.reason, pending: this.pending?.track?.title ?? null, current: this.current?.id ?? null },
        now);
      if (d.action === 'command-next') {
        await this.commandNext(d.reason);
      } else if (d.action === 'command-timeout') {
        const exp = this.expected!;
        this.expected = null;
        this.logOnce(`timeout:${exp.id}`, 'error', `Spotify transport: "${exp.item?.track?.title ?? exp.id}" ${d.reason} — ${exp.attempts >= 2 ? 'giving up on it' : 'retrying once'}`);
        this.noteFailure('never started');
        if (exp.attempts >= 2) {
          if (exp.item) this.deps.onUnplayable(exp.item, 'never started');
          if (this.pending === exp.item) this.pending = null;
          await this.commandNext('after a track that never started');
        } else {
          await this.command(exp.id, exp.item, exp.attempts + 1, 'retry', exp.song);
        }
      }
    } catch (err: any) {
      this.logOnce('tick-error', 'error', `Spotify transport tick failed: ${err?.message ?? err}`);
    } finally {
      this.busy = false;
    }
  }

  private async handleEvent(ev: SpotifyPlayerEvent): Promise<void> {
    const { current, meaning } = applyEvent(this.current, ev);
    this.current = current;
    switch (meaning.kind) {
      case 'started': {
        const exp = this.expected;
        if (exp && exp.id === meaning.trackId) {
          // The commanded track began: tell the mixer, release the item.
          this.expected = null;
          this.reclaimAttempts = 0;
          this.failStreak = 0;
          this.holdUntil = 0;
          if (this.pending === exp.item) this.pending = null;
          await this.setGap(false);
          const song = exp.item?.track ?? exp.song ?? (await this.deps.songById(meaning.trackId).catch(() => null)) ?? { id: meaning.trackId };
          const lag = await this.deps.mixerTrack(mixerMetadataFor({ ...song, id: meaning.trackId }));
          this.deps.log('scheduler', `Spotify: "${song.title ?? meaning.trackId}" started on the receiver${lag ? ` (mixer mark in ${lag.lagSec.toFixed(1)}s)` : ''}${exp.item ? '' : ' — pool fallback, nothing was picked in time'}`);
          return;
        }
        // A track we did not command (a phone on the same account, autoplay,
        // a reclaim that lost the race).
        const action = mismatchAction(this.deps.mismatchPolicy(), this.reclaimAttempts);
        if (action === 'reclaim' && (exp || this.pending)) {
          this.reclaimAttempts++;
          const want = exp ?? { id: this.pending!.track!.id!, item: this.pending, song: null, commandedAt: this.now(), attempts: 0 };
          this.deps.log('error', `Spotify: receiver started "${meaning.trackId}" instead of "${want.item?.track?.title ?? want.id}" — reclaiming (attempt ${this.reclaimAttempts})`);
          await this.deps.transferHere(false);
          await this.command(want.id, want.item, (exp?.attempts ?? 0) + 1, 'reclaim', want.song);
          return;
        }
        // Adopt: publish what is actually playing so now-playing is never wrong
        // for long (spec §15). The queue sees an unknown id → source 'auto'.
        this.expected = null;
        this.reclaimAttempts = 0;
        await this.setGap(false);
        const song = (await this.deps.songById(meaning.trackId).catch(() => null)) ?? { id: meaning.trackId };
        await this.deps.mixerTrack(mixerMetadataFor({ ...song, id: meaning.trackId }));
        this.deps.log('scheduler', `Spotify: following "${song.title ?? meaning.trackId}" — started outside the station`);
        return;
      }
      case 'ended':
        // Silence until the next track starts is ours, not dead air.
        await this.setGap(true);
        return;
      case 'unavailable': {
        const exp = this.expected;
        if (exp && (!meaning.trackId || meaning.trackId === exp.id)) {
          this.expected = null;
          await this.refused(exp, 'unavailable', 'is unavailable on this account/market', true);
        }
        return;
      }
      case 'session': {
        // librespot fires session_connected whenever a Connect CLIENT connects —
        // including OUR OWN play command — so it is not a receiver restart and
        // must never re-command anything (that was the first run's runaway
        // loop). A receiver that really restarted shows up as silence (1c) or a
        // start timeout, both handled by the tick. Log once a minute at most.
        this.logOnce(`session:${meaning.connected}`, 'scheduler', `Spotify receiver session ${meaning.connected ? 'connected' : 'disconnected'}`);
        return;
      }
      default:
        return;
    }
  }

  // Command whatever should play next: the pending pick, else a pool fallback.
  private async commandNext(reason: string): Promise<void> {
    const item = this.pending;
    if (item?.track?.id) {
      await this.command(item.track.id, item, 1, reason);
      return;
    }
    const song = await this.deps.fallbackSong().catch(() => null);
    if (!song?.id) {
      this.logOnce('no-fallback', 'error', `Spotify transport: nothing to play (${reason}) and the pool is empty — the mixer's emergency loop covers the air`);
      await this.setGap(false); // let the guard speak
      // AN EMPTY POOL IS A FAILURE AND MUST BE BACKED OFF LIKE ONE. This branch
      // used to return without touching `lastCommandAt`, `failStreak` or
      // `holdUntil` — and since seam-pure returns `command-next` unconditionally
      // once the current track has ended, the 500 ms tick called this ~7,200
      // times an hour. Each call reaches `fallbackSong()` → `pool.get()`, and an
      // empty pool has a two-minute TTL, so every other minute it fell through
      // to a FULL catalogue walk: on the order of 1,800–4,500 requests an hour
      // against a metered quota, with `logOnce`'s 60 s throttle printing one
      // line a minute so it looked idle.
      this.noteFailure('the pool is empty');
      return;
    }
    this.deps.log('scheduler', `Spotify transport: no pick ready (${reason}) — playing "${song.title}" from the pool`);
    await this.command(song.id, null, 1, reason, song);
  }

  private async command(trackId: string, item: QueueItem | null, attempts: number, reason: string, song: any | null = null): Promise<void> {
    // Last line before a request is spent. handoff() already declines a known
    // refusal, but a pool fallback and a retry reach here by other routes.
    if (this.deps.isRefused(trackId)) {
      this.deps.log('scheduler', `Spotify: not commanding "${item?.track?.title ?? song?.title ?? trackId}" — Spotify refused it before`);
      if (item) {
        this.deps.onUnplayable(item, 'known unavailable');
        if (this.pending === item) this.pending = null;
      }
      return;
    }
    // Hard floor between plays, whatever the reason: two commands a second is
    // never a station, it is a loop.
    if (this.lastCommandAt != null && this.now() - this.lastCommandAt < MIN_COMMAND_GAP_MS) {
      this.holdUntil = this.lastCommandAt + MIN_COMMAND_GAP_MS;
      // The command did not go out, so whatever urgency brought us here still
      // applies. Without re-arming this a substitute deferred by the floor lost
      // its claim and then waited out the whole idle window instead.
      this.resumeNow = true;
      return;
    }
    this.lastCommandAt = this.now();
    const exp: Expected = { id: trackId, item, song, commandedAt: this.now(), attempts };
    this.expected = exp;
    strace('command', `play ${trackId} (${reason})`, { id: trackId, title: item?.track?.title ?? song?.title, attempts, reason });
    const r = await this.deps.play(trackId);
    if (r.ok) return;
    this.expected = null;
    this.deps.log('error', `Spotify: play "${item?.track?.title ?? trackId}" failed (${r.reason}: ${r.message}) [${reason}]`);
    // A 403 on the play command is the same verdict librespot's `unavailable`
    // event gives, arriving by the other route — so it takes the same path:
    // remembered, and offered one alternative release. `chain` is false because
    // the tick is about to run anyway and commandNext from inside command()
    // would recurse.
    if (r.reason === 'unplayable') {
      await this.refused(exp, r.message || 'unplayable', 'was refused by Spotify', false);
      return;
    }
    this.noteFailure(`play ${r.reason}`);
    // no-device / auth / error: leave `pending` in place; the next tick retries
    // after the backoff, and the doctor/status shows why.
  }

  // Spotify will not play this track: remember it, and try ONE other release of
  // the same recording before giving the slot up.
  //
  // Remembering is the half that matters. Without it the picker offered the same
  // dead track on the very next cycle — measured at 212 consecutive unresolvable
  // picks of one song, each costing an LLM call and a play command, with the auto
  // playlist covering the air throughout. keep() reads the store, so one refusal
  // removes the track from every pick path at once.
  //
  // The substitute is a bonus, not a guarantee, and it is bounded three ways: one
  // search per queue item (`altTried`), never for a pool fallback (drawing
  // another pool track is free and a search is not), and skipped entirely while
  // the rate-limit gate is shut (source.ts owns that check).
  //
  // `chain` is whether to command the next track here. True for librespot's
  // `unavailable`, which arrives mid-air with the slot already empty; false for a
  // play command's own 403, where the caller is already inside command() and the
  // tick is about to try again anyway.
  private async refused(exp: Expected, reason: string, phrase: string, chain: boolean): Promise<void> {
    const song = exp.item?.track ?? exp.song ?? null;
    const title = song?.title ?? exp.id;

    this.deps.noteRefused(exp.id, {
      title: String(song?.title ?? ''),
      artist: String(song?.artist ?? ''),
      reason,
    });
    this.deps.log('error', `Spotify: "${title}" ${phrase} — dropped, and remembered so nothing picks it again`);
    strace('refused', `${exp.id} refused (${reason})`, { id: exp.id, title, reason });

    // A pool fallback has no queue item and needs no substitute: the next tick
    // simply draws another pool track, which costs nothing.
    if (exp.item && !this.altTried.has(exp.item)) {
      this.altTried.add(exp.item);
      const alt = await this.deps.findAlternative(song ?? { id: exp.id }).catch(() => null);
      if (alt?.id) {
        this.deps.onTrackSubstituted(exp.item, alt);
        this.pending = exp.item;
        this.resumeNow = true;
        this.deps.log('scheduler', `Spotify: playing "${alt.title}"${alt.album ? ` from ${alt.album}` : ''} instead — same recording, a release this account can play`);
        // Deliberately NOT noteFailure(): the transport is making progress, and
        // the substitute's own outcome is what gets counted. It is also not
        // commanded inline — command() early-returns under the 3s floor and
        // would swallow it silently, so it goes back through `pending` and the
        // normal tick picks it up, still inside every existing bound.
        return;
      }
      this.deps.log('scheduler', `Spotify: no other release of "${title}" is playable on this account — picking something else`);
    }

    if (exp.item) this.deps.onUnplayable(exp.item, reason);
    if (this.pending === exp.item) this.pending = null;
    this.noteFailure(reason);
    if (chain && this.now() >= this.holdUntil) await this.commandNext('after an unavailable track');
  }

  // Consecutive failures (a play refused, a track never starting, `unavailable`)
  // back the transport off: 30 s, doubling to 10 min, cleared by a real start.
  // The mixer's emergency loop covers the air meanwhile — that is what it is
  // for, and it costs Spotify nothing.
  private noteFailure(what: string): void {
    this.failStreak++;
    if (this.failStreak < 2) return;
    const wait = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (this.failStreak - 2));
    this.holdUntil = this.now() + wait;
    this.deps.log('error', `Spotify transport: ${this.failStreak} failures in a row (${what}) — holding ${Math.round(wait / 1000)}s before the next command`);
  }

  private async setGap(on: boolean): Promise<void> {
    if (this.gapOn === on) return;
    this.gapOn = on;
    this.gapSince = on ? this.now() : 0;
    await this.deps.mixerGap(on);
  }

  private logOnce(key: string, kind: string, line: string, everyMs = 60_000): void {
    const last = this.lastLog.get(key) ?? 0;
    if (this.now() - last < everyMs) return;
    this.lastLog.set(key, this.now());
    this.deps.log(kind, line);
  }
}

// ── production wiring ───────────────────────────────────────────────────────

let instance: SpotifyTransport | null = null;

export async function startSpotifyTransportIfActive(): Promise<SpotifyTransport | null> {
  const source = await import('../../source.js');
  if (!source.activeCapabilities().hasLiveTransport || source.activeSourceId() !== 'spotify') return null;

  // Start the genre drip FIRST, and on its own. It used to be the last
  // statement of this function, behind ~50 lines and six dynamic imports that
  // can throw — and server.ts swallows a throw here into one console line, so
  // any transport-start failure silently switched enrichment off for the life
  // of the process with nothing to distinguish it from "nothing left to do".
  // The drip needs only the pool, so it should not be able to fail with the
  // receiver.
  const { startSpotifyGenreDrip } = await import('./source.js');
  startSpotifyGenreDrip();
  const { queue } = await import('../../../broadcast/queue.js');
  const { setLiveTransport } = await import('../../../broadcast/queue/transport.js');
  const liq = await import('../../../broadcast/liquidsoap-control.js');
  const markers = await import('../../../broadcast/spotify-player.js');
  const { spotifyClient, spotifySettings, spotifySource, receiverDeviceName, spotifyPool, findAlternativeTrack } = await import('./source.js');
  const { markUnplayable, isKnownUnplayable } = await import('./unplayable-file.js');
  const { readLibrespotToken, writeLibrespotToken } = await import('./token-file.js');
  const { SpotifyPlaybackController } = await import('./playback.js');

  const controller = new SpotifyPlaybackController({
    client: spotifyClient,
    deviceName: receiverDeviceName,
    log: (l) => queue.log('scheduler', l),
  });
  instance = new SpotifyTransport({
    play: (id) => controller.play(id),
    transferHere: (p) => controller.transferHere(p),
    playbackState: async () => {
      const st: any = await spotifyClient().getPlaybackState();
      const id = st?.item?.id;
      if (!st || typeof id !== 'string') return null;
      const dev = await controller.deviceId();
      return {
        trackId: id,
        positionMs: Number(st.progress_ms) || 0,
        durationMs: Number(st.item?.duration_ms) || null,
        playing: !!st.is_playing,
        onReceiver: !!dev && st.device?.id === dev,
      };
    },
    mixerTrack: (m) => liq.spotifyTrack(m),
    mixerGap: (on) => liq.spotifyGap(on),
    readEvents: (afterSeq) => markers.spotifyEventsSince(afterSeq),
    readPlayerEvent: () => markers.currentSpotifyPlayerEvent(),
    readAudioState: () => markers.currentSpotifyAudioState(),
    songById: (id) => spotifySource.getSong(id),
    fallbackSong: async () => (await spotifySource.getRandomSongs({ size: 1 }))[0] ?? null,
    findAlternative: (want) => findAlternativeTrack(want),
    // Two local writes, no request: remember the refusal, and take the row out
    // of the live pool so the tagger, coverage and the orphan reconcile see the
    // same library the picker does. The SNAPSHOT deliberately keeps it (pool.ts).
    noteRefused: (trackId, info) => {
      markUnplayable(trackId, info);
      spotifyPool().dropTrack(trackId);
    },
    isRefused: (trackId) => isKnownUnplayable(trackId),
    // The queue's own error wording is written for the file path and points at a
    // `protocol.subhttp` line that does not exist in Spotify mode, so the reason
    // is passed in rather than left to the default.
    onUnplayable: (item, reason) => queue.onPushResolveFailed(item, {
      reason,
      detail: `Spotify would not play it on the station's receiver (${reason}). It has been remembered, so the picker will not offer it again.`,
    }),
    onTrackSubstituted: (item, track) => queue.substituteTrack(item, track),
    log: (kind, line) => queue.log(kind, line),
    seamLeadMs: () => Number(spotifySettings().seamLeadMs ?? 1500),
    mismatchPolicy: () => (spotifySettings().mismatch === 'follow' ? 'follow' : 'reclaim'),
  });
  setLiveTransport(instance);
  instance.start();

  // Keep the receiver's login token fresh from its refresh token, so a wiped
  // librespot credential cache re-signs in without the operator. Hourly
  // tokens, refreshed every 50 minutes; a failure just logs (the cache is the
  // normal path — this file is only read on a cold login).
  //
  // The receiver flow is a PUBLIC PKCE client, and Spotify ROTATES its refresh
  // token on every refresh: the one we just spent is dead. Persisting the new
  // one is therefore not an optimisation, it is the whole loop — without it the
  // first successful refresh silently strands the stored token and every later
  // attempt comes back "Refresh token revoked", hourly, forever. The app client
  // has always done this (client.ts onRefreshToken); this half had not.
  const { refreshReceiverToken } = await import('./receiver-auth.js');
  const { saveSecrets } = await import('../../../setup/secrets.js');
  const refresh = async () => {
    const rt = process.env.SPOTIFY_RECEIVER_REFRESH_TOKEN;
    if (!rt) return;
    const cur = await readLibrespotToken();
    if (cur && cur.expiresAt - Date.now() > 15 * 60 * 1000) return;
    try {
      const tok = await refreshReceiverToken(rt);
      await writeLibrespotToken(tok.accessToken, tok.expiresAt);
      if (tok.refreshToken && tok.refreshToken !== rt) {
        try { await saveSecrets({ SPOTIFY_RECEIVER_REFRESH_TOKEN: tok.refreshToken }); }
        catch (err: any) { queue.log('error', `Spotify receiver: could not persist the rotated refresh token — the next refresh will be rejected: ${err?.message ?? err}`); }
      }
    } catch (err: any) {
      // A revoked or otherwise dead grant will never recover on its own. Drop
      // it so the status reads "not signed in" and the operator is told what to
      // do, instead of an hourly error against a token that cannot work.
      const msg = String(err?.message ?? err);
      if (/revoked|invalid_grant/i.test(msg)) {
        try { await saveSecrets({ SPOTIFY_RECEIVER_REFRESH_TOKEN: '' }); } catch { /* the log below is what matters */ }
        queue.log('error', 'Spotify receiver sign-in expired (refresh token revoked). Sign the receiver in again: Settings → Music source → Playback → Sign the receiver in.');
        return;
      }
      queue.log('error', `Spotify receiver token refresh failed: ${msg}`);
    }
  };
  void refresh();
  const t = setInterval(() => { void refresh(); }, 50 * 60 * 1000);
  (t as any).unref?.();
  return instance;
}

export function spotifyTransport(): SpotifyTransport | null {
  return instance;
}
