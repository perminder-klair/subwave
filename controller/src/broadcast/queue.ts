// Queue manager — keeps the in-memory queue and writes track URIs
// to the file Liquidsoap watches. A now-playing watcher rotates items
// between upcoming → current → history based on what Liquidsoap reports.
//
// This module owns the Queue class and the singleton every caller uses. The
// pieces that aren't the class live in ./queue/ and are re-exported below, so
// `from './queue.js'` still reaches the whole surface:
//
//   types.ts     the shapes that flow through the queue
//   pure.ts      side-effect-free helpers and pacing constants
//   kinds.ts     the voice-kind registry the DJ recap reads
//   voice-io.ts  handoff-file writes + the spoken-segment serialiser

import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import { config } from '../config.js';
import { writeFileAtomic } from '../util/atomic-file.js';
import * as subsonic from '../music/subsonic.js';
import * as mix from '../music/mix.js';
import * as library from '../music/library.js';
import * as loudness from '../music/loudness.js';
import * as silenceTrim from '../music/silence-trim.js';
import * as blocklist from '../music/blocklist.js';
import { artistRootKey, trackKey } from '../music/recency.js';
import { speak, voiceGainDb } from '../audio/tts.js';
import * as djAgent from './dj-agent.js';
import * as programme from './programme.js';
import * as sfx from './sfx.js';
import * as jingles from './jingles.js';
import * as beds from './beds.js';
import * as bedPolicy from './bed-policy.js';
import * as session from './session.js';
import type { TurnMeta } from './session.js';
import type { PromptMemoryEntry } from './prompt-memory.js';
import { getFullContext, getClockContext, energyForDaypart } from '../context.js';
import * as settings from '../settings.js';
import { logEvent } from '../observability/events.js';
import { djCallsAllowed, presentListeners } from './listeners.js';
import { autoVoiceAllowed } from './voice-policy.js';
import { stationIdDaypartDrifted } from './clock-policy.js';
import * as webhooks from './webhooks.js';
import * as scrobble from './scrobble.js';
import * as liquidsoapControl from './liquidsoap-control.js';
import {
  drainAction,
  introRenderBudgetSec,
  playableDurationSec,
  remainingSec,
  shouldDeadlinePick,
  DEADLINE_PICK_COOLDOWN_SEC,
} from './drain-policy.js';
import {
  commitSatisfied,
  skipPrepAction,
  SKIP_COMMIT_WAIT_MS,
  SKIP_POLL_INTERVAL_MS,
} from './skip-policy.js';
import * as stemBlend from './stem-blend.js';
import type {
  DjLogEntry,
  NowPlaying,
  Persona,
  QueueItem,
  RecentPlay,
  Track,
} from './queue/types.js';
import {
  BACKFILL_DEDUP_MAX_GAP_MS,
  EMPTY_DJ_QUEUE_CLEAR_THRESHOLD,
  PICK_SHOW_LOOKAHEAD_SEC,
  boundaryCarriesTrackVoice,
  exchangeSegment,
  formatAgo,
  knownDurationSec,
  linkClockDrifted,
  nextTransitionLabel,
  pickLeadSec,
  pickLinkInterval,
  playAlreadyRecorded,
  shouldDropStaleLink,
  sleep,
  voiceChannelFor,
} from './queue/pure.js';
import {
  PUSH_PROBE_INTERVAL_MS,
  PUSH_PROBE_MAX_READS,
  probeVerdict,
  repickAfterFailure,
} from './resolve-probe.js';
import {
  DEDUPE_KINDS,
  KIND_LABEL,
  PENDING_VOICE_MAX_AGE_MS,
  TRACK_TIED_KINDS,
  VOICE_KINDS,
} from './queue/kinds.js';
import {
  BED_MARKER_FRESH_MS,
  VOICE_LEADIN_MS,
  airVoice,
  speechDurationMs,
  writeHandoff,
  jingleAiredAtMs,
  type QueuedVoice,
  type VoiceHandoff,
} from './queue/voice-io.js';
import { awaitIntroRender, IntroRenderTracker } from './queue/intro-render.js';
import { notifyQueued, notifySpoken } from './voice-events.js';

// Everything the outside world is told about ONE spoken segment, held in a
// single value because it is now read twice — once when the clip is committed
// (onQueued) and once when it airs (onSpoken). Two hand-built copies at each of
// the four call sites is exactly the drift #1382 removed.
interface SegmentDesc {
  kind: string;
  /** Which handoff file carried the clip — the caller picked it, so it says
   *  so rather than letting the payload re-derive it from `kind` and get a
   *  boundary-deferred ident (say-kind, intro channel) wrong. */
  channel: 'say' | 'intro';
  text: string;
  meta?: TurnMeta;
  persona?: Persona | null;
  /** Booth-log line when it differs from the spoken text (banter prefixes the speaker). */
  logText?: string | null;
  /** Whether this segment also fires the legacy dj.say/dj.link event. */
  legacy?: boolean;
}

// Re-exported so every existing `from './queue.js'` import keeps working.
export { BACKFILL_DEDUP_MAX_GAP_MS, boundaryCarriesTrackVoice, playAlreadyRecorded, shouldDropStaleLink } from './queue/pure.js';
export { registerSkillKinds } from './queue/kinds.js';
export type { NowPlaying, QueueItem, Track } from './queue/types.js';

// Manual jingle presses that may be pending at once (see playJingle). A bound on
// a runaway loop across different filenames, not a policy on how many
// announcements an operator may line up.
const PENDING_JINGLE_MAX = 3;
// How long a press stays pending before it is assumed lost. A mixer restart
// empties jingle_now_queue and drops the request with no signal, so this is what
// stops that from wedging the button shut. Generously past any single track, so
// it never retires a press that is merely waiting for its boundary.
const PENDING_JINGLE_TTL_MS = 30 * 60 * 1000;

// transitions far more often — a working DJ talks across most of them.
class Queue {
  upcoming: QueueItem[] = [];  // request items pushed by listeners, not yet playing
  current: QueueItem | null = null;    // what's broadcasting right now (request or auto)
  history: QueueItem[] = [];   // finished tracks, newest first
  djLog: DjLogEntry[] = [];    // controller-level events for the web UI
  lastSeenKey: string | null = null;   // for change detection in the watcher
  _nowPlaying: NowPlaying | null = null;   // last parse of now-playing.json, refreshed by the watcher
  _nowPlayingFresh = false;            // true once the watcher's first tick has landed
  senderBusy = false;          // drain-to-Liquidsoap mutex
  pendingForceDrain = false;   // a forced drain arrived while senderBusy — re-run on release
  pickerBusy = false;          // prevent concurrent LLM picks
  autoPick = true;             // toggle: should we ask Ollama for next track when idle
  autoLink = true;             // toggle: random DJ links between auto tracks
  tracksUntilLink = pickLinkInterval();
  _transitionsSinceSfx = 999;  // DJ-mode transition-FX spacing counter (see drainToLiquidsoap)
  _lastBed: string | null = null;      // last bed aired — anti-repeat for bed-policy.pickBed
  _lastBedStartedAt = 0;               // bed-playing.json's last-seen startedAt — the edge onBedStarted fires on
  _recentEffects: string[] = [];  // the model's last few transition CHOICES — anti-streak guard + fed back into the pick event turn
  _persistTimer: NodeJS.Timeout | null = null; // debounce for the queue.json snapshot
  _recentPlaysTimer: NodeJS.Timeout | null = null; // debounce for the recent-plays.json sidecar
  _recentPlays: RecentPlay[] = [];
  _emptyDjQueueStreak = 0;      // consecutive reconcile checks seeing an empty dj_queue while sent items remain — see reconcileWithDjQueue
  _resolveFailStreak = 0;       // consecutive pushes Liquidsoap never resolved — re-pick budget, see onPushResolveFailed
  _deadlinePickAt = 0;          // last deadline-pick ATTEMPT (ms epoch) — failure-retry cooldown, see maybeDeadlinePick
  _pendingVoice: { text: string; kind: string; wavPath: string; persona: Persona | null; meta: TurnMeta; daypart: string | null; t: number } | null = null; // one boundary-deferred segment awaiting the next track start — see announceAtNextTrack
  _introRenders = new IntroRenderTracker<QueueItem>(); // timed-out pre-renders stay reusable by airIntro
  _pendingJingles = new Map<string, number>(); // manual jingle presses handed over but not yet heard — see playJingle

  // Snapshot upcoming/current/history to disk. The queue is otherwise purely
  // in-memory, so a controller restart (every `--build controller` rebuild)
  // would drop tracks already handed to Liquidsoap's dj_queue — they'd still
  // play but reappear as untracked `auto` plays. Debounced so a burst of
  // mutations writes once.
  persist() {
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(async () => {
      this._persistTimer = null;
      try {
        await writeFileAtomic(config.queue.file, JSON.stringify({
          upcoming: this.upcoming,
          current: this.current,
          history: this.history,
          savedAt: new Date().toISOString(),
        }, null, 2));
      } catch (err) {
        console.error('[queue] persist failed:', (err as Error).message);
      }
    }, 500);
  }

  // Write the rolling recent-plays sidecar. Separate from `persist()` because
  // it has different shape and a different cap, and we want the heavy-traffic
  // queue.json writes not to block on this one (and vice versa).
  persistRecentPlays() {
    if (this._recentPlaysTimer) return;
    this._recentPlaysTimer = setTimeout(async () => {
      this._recentPlaysTimer = null;
      try {
        await writeFileAtomic(config.queue.recentPlaysFile,
          JSON.stringify(this._recentPlays, null, 2));
      } catch (err) {
        console.error('[queue] recent-plays persist failed:', (err as Error).message);
      }
    }, 500);
  }

  // Boot recovery — reload the persisted queue so requests/picks already sent
  // to Liquidsoap stay tracked across a controller restart. `lastSeenKey` is
  // primed from the restored `current` so the watcher doesn't re-fire for the
  // track that's still on air; if the track changed during the downtime the
  // key differs and the watcher reconciles normally (see onTrackStarted, which
  // drops any upcoming items Liquidsoap consumed while the controller was down).
  recover() {
    if (!existsSync(config.queue.file)) return;
    try {
      const stored = JSON.parse(readFileSync(config.queue.file, 'utf8'));
      // Drop anything queued long enough ago that Liquidsoap has certainly
      // played past it — guards against a stale snapshot from a long downtime
      // resurrecting tracks as permanent "Up next" zombies.
      const cutoff = Date.now() - 2 * 60 * 60 * 1000;
      this.upcoming = (Array.isArray(stored.upcoming) ? stored.upcoming : [])
        .filter((i: QueueItem) => i?.track?.title && new Date(i.queuedAt || 0).getTime() > cutoff);
      this.current = stored.current || null;
      this.history = Array.isArray(stored.history) ? stored.history : [];
      if (this.current?.track) {
        const t = this.current.track;
        this.lastSeenKey = `${t.id || ''}|${t.title}|${t.artist || ''}`;
      }
      this.log('scheduler',
        `Queue recovered: ${this.upcoming.length} upcoming, ${this.history.length} played`);

      // Re-drain any items snapshotted as sent:false mid-TTS during a crash.
      if (this.upcoming.some(i => !i.sent)) {
        void this.drainToLiquidsoap();
      }

      // Reconcile sent:true items against the live dj_queue after a short
      // delay so Liquidsoap has time to accept telnet connections on boot.
      if (this.upcoming.some(i => i.sent)) {
        setTimeout(() => { void this.reconcileWithDjQueue(); }, 3000);
      }
    } catch (err) {
      console.error('[queue] recover failed:', (err as Error).message);
    }
    if (existsSync(config.queue.recentPlaysFile)) {
      try {
        const arr = JSON.parse(readFileSync(config.queue.recentPlaysFile, 'utf8'));
        if (Array.isArray(arr)) {
          // Drop anything older than 96h on boot — keeps the file from
          // ballooning if the cap was raised between restarts, while holding
          // enough history to supply a maxed count-based no-repeat window
          // (clampNoRepeatWindow: up to 1000 distinct ≈ 2-3 days of air).
          const cutoff = Date.now() - 96 * 3_600_000;
          this._recentPlays = arr
            .filter((p: RecentPlay) => p && p.endedAt && new Date(p.endedAt).getTime() > cutoff)
            .slice(0, config.queue.recentPlaysMax);
        }
      } catch (err) {
        console.error('[queue] recent-plays recover failed:', (err as Error).message);
      }
    }
    // Backfill from the events JSONL log — without this, a controller restart
    // resets the 12h block window to whatever's in the sidecar file (often
    // empty or only minutes deep), leaving heavy-rotation tracks free to
    // repeat right after boot. Observed: "2 AM" by Karan Aujla picked at
    // 00:19 UTC because its actual last play (23:11 UTC) was outside the
    // sidecar's reach. The events log has every track.play and is durable.
    this.backfillRecentPlaysFromEvents();
    this.log('scheduler',
      `Recent-plays loaded: ${this._recentPlays.length} entries (last 24h)`);
  }

  // Read the last 24h of track.play events from state/logs/events-*.jsonl
  // and merge any missing entries into _recentPlays. Events lack a track id
  // (only title + artist + t), so backfilled entries rely on the title|artist
  // key path in tools.ts collect() to block repeats. Cheap: ~24h of plays =
  // ~500 events, two file reads max.
  backfillRecentPlaysFromEvents() {
    try {
      const cutoff = Date.now() - 24 * 3_600_000;
      // Dedup against plays recordPlay already logged — matched on title|artist
      // with the existing end-stamp inside a track-length window of the event's
      // start (playAlreadyRecorded), NOT an exact-timestamp key. The old exact
      // key never matched (end-stamp ≠ start `t`), so every play was duplicated.
      const filled: typeof this._recentPlays = [];
      const today = new Date().toISOString().slice(0, 10);
      const yest = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      const stateDir = config.queue.file.replace(/\/queue\.json$/, '');
      for (const day of [today, yest]) {
        const path = `${stateDir}/logs/events-${day}.jsonl`;
        if (!existsSync(path)) continue;
        const text = readFileSync(path, 'utf8');
        for (const line of text.split('\n')) {
          if (!line) continue;
          try {
            const e = JSON.parse(line);
            if (e.type !== 'track.play' || !e.t || !e.title) continue;
            if (new Date(e.t).getTime() < cutoff) continue;
            // Compare against both the existing sidecar AND plays already filled
            // in this pass, so two events for one play can't both slip through.
            if (playAlreadyRecorded(this._recentPlays, e, BACKFILL_DEDUP_MAX_GAP_MS)) continue;
            if (playAlreadyRecorded(filled, e, BACKFILL_DEDUP_MAX_GAP_MS)) continue;
            filled.push({
              id: null,
              title: e.title || null,
              artist: e.artist || null,
              endedAt: e.t,
            });
          } catch {}
        }
      }
      if (filled.length === 0) return;
      this._recentPlays = [...this._recentPlays, ...filled]
        .sort((a, b) => b.endedAt.localeCompare(a.endedAt))
        .slice(0, config.queue.recentPlaysMax);
      this.persistRecentPlays();
    } catch (err) {
      console.error('[queue] backfill from events failed:', (err as Error).message);
    }
  }

  log(kind: string, message: string, meta: Record<string, unknown> = {}) {
    const entry = { id: Date.now() + Math.random(), kind, message, meta, t: new Date().toISOString() };
    this.djLog.unshift(entry);
    this.djLog = this.djLog.slice(0, 200);
    console.log(`[${kind}] ${message}`);
  }

  // Compact recap of recent on-air DJ utterances for injection into Ollama
  // prompts so the DJ stops repeating openers. Returns formatted lines or
  // null when nothing relevant has aired. Wider window catches slow-firing
  // kinds (hourly, station ID) so the DJ doesn't echo something it said
  // an hour ago.
  // `prior` reads the session a hard roll just archived instead of the live one
  // — the mic-pass sign-off is the single caller (session.priorPromptMemory).
  getDjRecap({ limit = 10, withinMinutes = 120, maxChars = 140, prior = false } = {}) {
    const cutoff = Date.now() - withinMinutes * 60_000;
    const seenDedupe = new Set<string>();
    const picked: PromptMemoryEntry[] = [];
    for (const entry of prior ? session.priorPromptMemory() : session.promptMemory()) {
      if (!VOICE_KINDS.has(entry.kind)) continue;
      if (new Date(entry.t).getTime() < cutoff) break;
      if (DEDUPE_KINDS.has(entry.kind)) {
        if (seenDedupe.has(entry.kind)) continue;
        seenDedupe.add(entry.kind);
      }
      picked.push(entry);
      if (picked.length >= limit) break;
    }
    if (picked.length === 0) return null;
    return picked.map((e) => {
      const ago = formatAgo(Date.now() - new Date(e.t).getTime());
      const msg = (e.message || '').replace(/\s+/g, ' ').trim();
      const truncated = msg.length > maxChars ? msg.slice(0, maxChars - 1) + '…' : msg;
      return `- ${ago} ago [${KIND_LABEL[e.kind] || e.kind}]: "${truncated}"`;
    }).join('\n');
  }

  // Recently played tracks, newest first. Compact shape for prompts.
  getRecentTracks(n = 6) {
    const out: { title: string; artist: string | null; album: string | null; year: number | null }[] = [];
    for (const h of this.history.slice(0, n)) {
      const t = h.track;
      if (!t || !t.title) continue;
      out.push({ title: t.title, artist: t.artist || null, album: t.album || null, year: t.year || null });
    }
    return out;
  }

  // Deduped recent artist names, newest first.
  getRecentArtists(n = 6) {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const h of this.history) {
      const a = h.track?.artist;
      if (!a || seen.has(a)) continue;
      seen.add(a);
      out.push(a);
      if (out.length >= n) break;
    }
    return out;
  }

  // First ~5 words of recent DJ utterances — fed to the prompt as an
  // explicit "don't open with any of these" list. Catches repeated openers
  // that the recap text alone glosses over.
  getRecentOpeners(n = 6, { prior = false } = {}) {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const entry of prior ? session.priorPromptMemory() : session.promptMemory()) {
      if (!VOICE_KINDS.has(entry.kind)) continue;
      const msg = (entry.message || '').replace(/^["'\s]+/, '').replace(/\s+/g, ' ').trim();
      if (!msg) continue;
      const opener = msg.split(/\s+/).slice(0, 5).join(' ');
      if (seen.has(opener.toLowerCase())) continue;
      seen.add(opener.toLowerCase());
      out.push(opener);
      if (out.length >= n) break;
    }
    return out;
  }

  // Timestamp (ms) of the most recent on-air spoken segment, or 0. Defaults to
  // every voice kind; pass `kinds` to narrow it (the segment director's
  // frequency floor asks only about the scheduler's wall-clock talkers —
  // idents/hourly/handoff — since track-tied links would mute it entirely on a
  // chatty station). Its private lastAnySegment counter only ever saw its own
  // segments, so this is how a just-aired ident suppresses a back-to-back one.
  getLastVoiceAt(kinds?: readonly string[]) {
    const match = kinds ? new Set(kinds) : VOICE_KINDS;
    for (const entry of this.djLog) {
      if (match.has(entry.kind)) return new Date(entry.t).getTime();
    }
    return 0;
  }

  // Timestamp (ms) of the most recent STANDALONE talk break, or 0 — every
  // voice kind except the track-tied intro channels ('link'/'dj-speak', which
  // air with nearly every pick and would mute a gap check outright on a chatty
  // station). Skill kinds (weather/news/…) count via VOICE_KINDS, so a gap
  // gated on this can't stack onto a segment the listener just heard.
  getLastTalkBreakAt() {
    for (const entry of this.djLog) {
      if (TRACK_TIED_KINDS.has(entry.kind)) continue;
      if (VOICE_KINDS.has(entry.kind)) return new Date(entry.t).getTime();
    }
    return 0;
  }

  // Add a track to `upcoming` and kick off the Liquidsoap sender.
  //
  // `introScript` is tied to THIS track but is NOT aired at queue time:
  // drainToLiquidsoap renders it to a WAV ahead of time and airIntro() writes
  // that WAV only when the track actually starts, so the voice lands over the
  // right song. `introKind` picks the engine routing (voice slot, gain trim)
  // and the DEFAULT duck channel — 'dj-speak' → say.txt (HEAVY duck, request
  // intros), 'link' → intro.txt (LIGHT duck, between-track links). It no longer
  // decides the channel outright: since #1465 a clip airing on a bed takes the
  // light duck whatever its kind, because the channel follows what the clip
  // plays OVER (airIntro's `overBed`).
  //
  // `linkPrev` is the track the intro BACK-ANNOUNCES. Deferring the line to air
  // time (#189) is only valid while this pick is still immediately-next; a
  // listener request slipping in ahead of it would make the baked-in "that was
  // X" name the wrong song, so airIntro uses linkPrev to detect that and drop
  // the back-announce. Null for request intros, which never back-announce.
  //
  // `linkClockAt` is the air moment the script was written against, set only
  // when the generator gave the model a clock to speak (#1314). airIntro drops
  // the line if the real seam lands too far from it — the forecast is made from
  // the on-air track's remaining play and goes badly wrong when the pick misses
  // that seam and auto.m3u fills the slot.
  async push({ track, requestedBy = null, intent = null, introScript = null, introKind = 'dj-speak', introPersona = null, aiPicked = false, allowDuplicate = false, linkPrev = null, linkClockAt = null }: {
    track: Track;
    requestedBy?: string | null;
    intent?: string | null;
    introScript?: string | null;
    introKind?: string;
    introPersona?: Persona | null;
    aiPicked?: boolean;
    allowDuplicate?: boolean;
    linkPrev?: { id?: string | null; title?: string | null; artist?: string | null } | null;
    linkClockAt?: Date | number | null;
  }) {
    // The blocklist is absolute — even explicit manual queueing is refused
    // until the entry is unblocked — so it sits above `allowDuplicate`. Every
    // playback path funnels through push() (dj-agent, requests, MCP, studio
    // queue), making this the last line even for sources that bypass the
    // subsonic/library filters.
    const blockHit = blocklist.hitOf(track);
    if (blockHit) {
      // Name what refused it — an id entry reads as before; a rule names
      // itself so the operator can find it on the Blocked tab (a seasonal
      // refusal otherwise looks like a random "not found" to whoever queued).
      const why = blockHit.kind === 'rule'
        ? `blocked by rule "${blockHit.label}"${blockHit.seasonal ? ' (out of season)' : ''}, refused`
        : 'on the never-play blocklist, refused';
      this.log('blocked', `${track?.title} — ${track?.artist} (${why})`);
      return -2;
    }
    // Applies to AI picks AND listener requests: two requests resolving to the
    // same song over the 25-45s identify/match window each read queuedIds()
    // before either reaches push(), so neither early read sees the other (#619).
    // This is the only synchronous point where both are visible — no await
    // between it and the upcoming.push() below — so it closes the race. -1 lets
    // the caller acknowledge honestly instead of queuing a back-to-back play;
    // `allowDuplicate` opts out an explicit operator action.
    if (!allowDuplicate && track?.id) {
      const dominated = this.upcoming.some(i => i.track?.id === track.id)
        || (this.current?.track?.id === track.id);
      if (dominated) {
        this.log('dedup-skip', `${track.title} -- ${track.artist} (already queued)`);
        return -1;
      }
    }
    const item = {
      track, requestedBy, intent, introScript, introKind, introPersona, aiPicked,
      // Only stamp a back-announce target when there's actually an intro/link to
      // air against it; a bare track carries no claim about what preceded it.
      linkPrev: (introScript && linkPrev)
        ? { id: linkPrev.id ?? null, title: linkPrev.title ?? null, artist: linkPrev.artist ?? null }
        : null,
      // Same gate as linkPrev: a bare track makes no claim about the clock, so
      // only a line that exists can carry the air moment it was written for.
      linkClockAt: (introScript && linkClockAt != null)
        ? (linkClockAt instanceof Date ? linkClockAt.getTime() : linkClockAt)
        : null,
      introWav: null as string | null,
      introAired: false,
      queuedAt: new Date().toISOString(),
      sent: false,
      confirmedInLiquidsoap: false,
    };
    this.upcoming.push(item);
    this.log('queued', `${track.title} — ${track.artist}`, { requestedBy, queueDepth: this.upcoming.length });
    this.persist();
    this.drainToLiquidsoap();  // fire-and-forget
    return this.upcoming.length;
  }

  // Drop now-blocked tracks from the upcoming queue — called when a blocklist
  // entry or rule is added/edited. Only undrained items (`!sent`) are
  // removable; anything already handed to Liquidsoap plays out (we never
  // interrupt), and the currently playing track is likewise left alone.
  // Returns how many dropped.
  purgeBlocked(): number {
    const keep = this.upcoming.filter(i => i.sent || !blocklist.isBlocked(i.track));
    const dropped = this.upcoming.length - keep.length;
    if (dropped > 0) {
      this.upcoming = keep;
      this.log('blocked', `purged ${dropped} upcoming track${dropped === 1 ? '' : 's'} now blocked by the never-play blocklist`);
      this.persist();
    }
    return dropped;
  }

  // Resolve {bpm, key} for a queued track: from the track object if it carries
  // analysis, else a library lookup (queued items hold only id/title/artist).
  mixAnalysisFor(track: Track | null): mix.Analysis {
    if (!track) return { bpm: null, key: null };
    const rec = track.id ? library.get(track.id) : null;
    // Measured ending (outro analysis) — track object first, else the library
    // record. Feeds the ending-aware exit canvas + the chop-over-fade veto.
    const outro = track.outro ?? rec?.outro ?? null;
    const ending = outro?.ending === 'fade' || outro?.ending === 'cold' ? outro.ending : null;
    const base = (track.bpm != null || track.musicalKey != null)
      ? { bpm: track.bpm ?? null, key: track.musicalKey ?? null }
      : { bpm: rec?.bpm ?? null, key: rec?.musicalKey ?? null };
    // Boundary keys (feature: key ranges) — what mixCompat actually compares
    // across a seam: this track's opening key when it's the incoming side, its
    // ending key when it's the outgoing one. Fall back to the dominant key.
    const keyRanges = track.keyRanges ?? rec?.keyRanges ?? null;
    const durSec = Number(track.duration) || rec?.durationSec || 0;
    const durMs = durSec > 0 ? durSec * 1000 : null;
    return {
      ...base,
      keyStart: mix.openingKeyFrom(keyRanges, base.key),
      keyEnd: mix.endingKeyFrom(keyRanges, durMs, base.key),
      ending,
      // Sung ending (tail vocal ranges vs the wind-down) — feeds the
      // vocal-tail exit shaping + the chop-over-voice veto.
      vocalTail: mix.vocalTailFor(outro?.vocalRanges, outro?.startMs),
    };
  }

  // Stash a clamped gain offset toward the operator's loudness target on the
  // track as `gainDb`. Null loudness from every allowed source leaves it
  // undefined, so getAnnotatedUri emits no liq_amplify and the track plays at
  // unity.
  //
  // The resolution lives in music/loudness.ts because the stem-blend render
  // needs the SAME answer (#1240) — a clip carries no liq_amplify, so the render
  // bakes this figure in, and a second implementation there is how rendered
  // seams ended up at a different level than the tracks around them.
  async applyLoudnessGain(track: Track | null) {
    if (!track) return;
    const gain = await loudness.resolveGainDb(track, msg => this.log('warn', msg));
    if (gain != null) track.gainDb = gain;
  }

  // How many transitions must pass between DJ-mode transition-FX, keyed off the
  // chattiness ladder. Infinity for silent/quiet personas → no transition FX.
  sfxTransitionGap(): number {
    const f = settings.effectiveFrequency();
    if (f === 'aggressive') return 4;
    if (f === 'chatty') return 6;
    if (f === 'moderate') return 8;
    return Infinity;
  }

  // The model's recent transition choices, oldest first — surfaced into the
  // pick event turn so the model can SEE its own habit and break it (it has
  // no other way to know what it recently chose; session-history imitation is
  // how both the all-normal and all-blend monocultures formed).
  recentTransitionChoices(): string[] {
    return [...this._recentEffects];
  }

  // Drop any transition-effect flags from a track (with a logged reason) so
  // getAnnotatedUri never stamps an effect the gate rejected.
  stripEffect(track: Track, reason: string) {
    const kind = track.sweep ? 'sweep' : track.blend ? 'blend' : track.dissolve ? 'dissolve' : track.chop ? 'chop' : track.loop ? 'loop' : 'washout';
    delete track.sweep;
    delete track.washout;
    delete track.blend;
    delete track.dissolve;
    delete track.chop;
    delete track.loop;
    this.log('mix', `${kind} dropped (${reason})`);
  }

  // Push an instrumental bed into dj_queue ahead of `item` — when its link
  // would outlast the song's own intro, or when the song is a listener request
  // and its opening is not the DJ's to talk over — so the DJ talks over the bed
  // rather than over the song. Sets item.bedded, which is how the bed's start
  // event (onBedStarted) finds the item whose link it should air — and only
  // that. The light-duck channel is onBedStarted's `overBed` to give, because
  // the flag says a bed was HANDED OVER while the marker says one is on air.
  //
  // Ordering is what makes this a controller-side feature rather than a mixer
  // one: the link's WAV was rendered a few lines up, so its real length is
  // readable here, before the track URI is written.
  //
  // Silent no-op on every path that isn't a bedded link or a bedded request —
  // beds off, request bedding off, no script, a link that fits the intro, or no
  // bed long enough.
  async maybePushBed(item: QueueItem) {
    const cfg = settings.get()?.beds;
    if (!cfg?.enabled) return;
    // Already bedded: a crash between the bed push and the track write leaves
    // this item unsent, and the recovery re-drain would otherwise queue a
    // SECOND bed ahead of it (~bedSec of voiceless filler between them).
    if (item.bedded) return;
    // Two reasons to bed, and they are gated separately (bed-policy.BedReason).
    // A LINK beds when the DJ would outlast the incoming intro. A listener
    // REQUEST beds because somebody asked for this track, so its opening bars
    // are theirs — front-pad the intro instead of talking over them (#1465).
    // `requestedBy` is the discriminator rather than introKind, because every
    // request path pushes 'dj-speak' and so does the studio's own bare push
    // (which carries no script and falls out one line down).
    const reason: bedPolicy.BedReason = item.requestedBy ? 'request' : 'link';
    if (reason === 'request') {
      if (!cfg.requestIntros) return;
    } else if (item.introKind !== 'link') {
      // An unrequested 'dj-speak' intro — nothing routes here today, and it
      // has no listener whose opening bars are being protected.
      return;
    }
    if (!item.introWav || !item.introScript || item.introAired) return;

    // Whatever plays right before this item is what the bed crosses in under —
    // the item just ahead in the (FIFO) queue, else the track on air now.
    const idx = this.upcoming.indexOf(item);
    const predecessor = (idx > 0 ? this.upcoming[idx - 1]?.track : null) ?? this.current?.track ?? null;

    // airIntro will drop a link whose rendered script names a predecessor that
    // no longer holds (shouldDropStaleLink) — and by then the bed is committed
    // and airs naked. The predecessor is final once this item drains (later
    // pushes append behind it), so evaluate the same drop here first.
    if (shouldDropStaleLink(item, predecessor)) return;

    try {
      const voiceMs = speechDurationMs(item.introWav, item.introScript);
      // The ramp budget is a property of the INCOMING track: how long may the
      // DJ talk before trampling its vocal? Analysis rides the track object when
      // present, else the library row (queued items hold only id/title/artist).
      const rec = item.track?.id ? library.get(item.track.id) : null;
      // The onset is measured from byte zero, and the drain may be about to cut
      // a leading blank off this very track — so shift it onto the trimmed
      // timeline before asking whether the link outlasts it. This is the same
      // correction intro-budget's firstVocalMsFor applies to the SAME
      // measurement; leaving it out here made the two disagree about one track,
      // with the prompt told the runway is 2s while the bed decision still
      // thought it was 8s and declined a bed the link needed. null (unknown)
      // and Infinity (instrumental) carry their meanings through untouched.
      const rawBudgetMs = bedPolicy.rampBudgetMs({
        vocalRanges: item.track?.vocalRanges ?? rec?.vocalRanges ?? null,
      });
      const budgetMs = rawBudgetMs != null && Number.isFinite(rawBudgetMs)
        ? silenceTrim.shiftOnsetMs(item.track, rawBudgetMs)
        : rawBudgetMs;
      // `reason` outranks the budget entirely for a request (bed-policy), so
      // the trim correction above only ever decides a LINK's bed.
      if (!bedPolicy.bedWanted(voiceMs, budgetMs, cfg, reason)) return;

      // The bed's marker (and its cue_out clock) starts at cross-FEED time, a
      // full predecessor-exit-canvas before the bed is dominant — so that
      // entry cross is dead time the bed must be sized to carry, and the link
      // is held for it in onBedStarted. The predecessor's own crossSec stamp
      // (applyMixTransition's ending-aware canvas) is exactly that length;
      // fall back to the operator's crossfade setting like getAnnotatedUri.
      // 0 is a legitimate value (a hard-cut station has NO entry canvas), so
      // guard with isFinite rather than `||` — `|| 10` would turn crossfade 0
      // into 10s of phantom dead time the listener hears as bare bed.
      const rawCross = Number(predecessor?.crossSec ?? settings.get()?.crossfadeDuration);
      const entryCrossSec = Math.min(15, Math.max(0, Number.isFinite(rawCross) ? rawCross : 10));

      const { bedSec, crossSec } = bedPolicy.bedLengthFor(voiceMs, cfg, entryCrossSec);
      const pick = bedPolicy.pickBed(await beds.catalog(), bedSec, this._lastBed, Math.random());
      if (!pick) {
        this.log('beds', `no bed long enough for a ${bedSec}s link — talking over "${item.track?.title}" instead`);
        return;
      }
      const path = await beds.getPath(pick.name);
      if (!path) return;

      await writeHandoff(config.liquidsoap.queueFile, beds.bedUri(path, { bedSec, crossSec }));
      item.bedded = true;
      item.bedEntrySec = entryCrossSec;
      this._lastBed = pick.name;

      // The entry-side transition effects applyMixTransition armed on this
      // track (sweep/dissolve/chop/blend, validated for the predecessor→item
      // pair) would now be applied to the OUTGOING bed at the bed→item cross —
      // radio.liq reads them off the incoming track's metadata. Same for the
      // armed transition stinger, which onTrackStarted fires at this item's
      // start, i.e. mid-ramp under the DJ's closing words. The bed replaced
      // the seam they were validated for, so they all come off. Exit-side
      // stamps (washout/loop/crossSec) govern this track's OWN ending and stay.
      if (item.track && (item.track.sweep || item.track.blend || item.track.dissolve || item.track.chop)) {
        const kind = item.track.sweep ? 'sweep' : item.track.blend ? 'blend' : item.track.dissolve ? 'dissolve' : 'chop';
        delete item.track.sweep;
        delete item.track.blend;
        delete item.track.dissolve;
        delete item.track.chop;
        delete item.track.chopPeriod;
        this.log('mix', `${kind} dropped (a bed replaced the transition it was validated for)`);
      }
      if (item.transitionSfx) delete item.transitionSfx;

      const why = reason === 'request' ? `requested by ${item.requestedBy}`
        : budgetMs == null ? `no vocal onset, over ${cfg.thresholdSec}s`
          : budgetMs === Infinity ? 'instrumental'
            : `vocals at ${Math.round(budgetMs / 1000)}s`;
      this.log('beds', `bed "${pick.name}" ${bedSec}s (${entryCrossSec}s entry cross) → ${crossSec}s ramp into "${item.track?.title}" (${Math.round(voiceMs / 1000)}s link, ${why})`);
    } catch (err) {
      // A bed is a garnish — never let it cost the station a track.
      this.log('error', `Bed push failed: ${(err as Error).message}`);
    }
  }

  applyMixTransition(item: QueueItem) {
    const persona: Persona | null = settings.getEffectivePersona();
    if (!item?.track) return;
    // Persona flipped out of DJ mode between the pick and the drain: the
    // effects gate below never runs, so make sure no flag survives to annotate.
    if (!persona?.djMode) {
      if (item.track.sweep || item.track.washout || item.track.blend || item.track.dissolve || item.track.chop || item.track.loop) this.stripEffect(item.track, 'dj mode off');
      return;
    }

    const idx = this.upcoming.indexOf(item);
    const prevTrack = (idx > 0 ? this.upcoming[idx - 1]?.track : null) || this.current?.track || null;
    if (!prevTrack) {
      // Nothing on-air to validate against (first track after boot) — an
      // effect on a cold start would garnish silence; drop it.
      if (item.track.sweep || item.track.washout || item.track.blend || item.track.dissolve || item.track.chop || item.track.loop) this.stripEffect(item.track, 'no predecessor');
      return;
    }

    const cur = this.mixAnalysisFor(prevTrack);
    const next = this.mixAnalysisFor(item.track);

    // The pair-sized adaptive blend is NOT computed here — liq_cross_duration
    // governs the crossfade at the STAMPED track's OWN end, and at this point in
    // the FIFO drain the predecessor is already annotated and gone. The
    // pair-drain hold (drain-policy.ts) is what makes it possible at all:
    // applyPairStamps() sizes the blend once the successor is known (#749). This
    // function keeps only the track-intrinsic work — ending-aware exit canvas
    // plus effect gating — still capped by the operator crossfade ceiling.
    const maxSec = settings.get()?.crossfadeDuration ?? null;

    // DJ transition effects (sweep/washout) — the agent proposes, the data
    // disposes; a rejected flag is stripped so getAnnotatedUri never stamps it.
    // A washout also gets canvas + tempo stamps on the flagged track ITSELF,
    // since its liq_cross_duration governs its own end, exactly where the wash
    // fires. The sweep needs no stamps: the transition into it is already sized
    // and its envelope scales to whatever d it gets.
    //
    // Auto-arm a washout when the cap will CUT this pick (duration >
    // effectiveMaxTrackSec → drain stamps liq_cue_out): the ending is a forced
    // mid-song exit, and the echo-out is what makes it sound intentional rather
    // than broken. Deterministic rather than an LLM choice — the controller
    // knows which tracks will be capped. Coexists with a sweep on the same pick
    // (sweep shapes ENTRY, washout EXIT). Requests are exempt from the cap, so
    // they never arm it.
    const capSec = item.requestedBy ? null : settings.effectiveMaxTrackSec();
    const durSec = knownDurationSec(item.track);
    const cappedExit = !!(capSec && durSec > capSec);
    // A DJ-chosen loop exit already makes a capped cut sound intentional —
    // don't stack the auto-washout on top of it (both shape the same ending,
    // and radio.liq's washout-wins precedence would silently eat the loop).
    if (cappedExit && !item.track.washout && !item.track.loop) {
      item.track.washout = true;
      item.track.washoutAuto = true;
    }

    // Ending-aware exit canvas (feature: outro analysis). The pair-sized
    // feature-1 value above can't be applied (#749), but a track's measured
    // ENDING is a property of the track alone, so its OWN exit canvas can be
    // stamped correctly here: a fade rides out long under whatever follows, a
    // cold end cuts tight. Skipped for a capped exit (the real ending never
    // airs — the auto-washout owns that cut); a washout/loop stamped below
    // overwrites it (those gestures own the exit).
    if (!cappedExit) {
      const outro = item.track.outro ?? (item.track.id ? library.get(item.track.id)?.outro : null) ?? null;
      if (outro) {
        // Measure the wind-down to the end that will actually AIR, not the
        // tagged one. A trailing blank drags outro.startMs earlier (the RMS
        // decay into silence reads as a fade), so an untrimmed durSec counts
        // the silence we are about to cut as part of the ramp and sizes the
        // exit canvas longer than the track has left.
        const trimEndSec = silenceTrim.resolveSilenceTrim(item.track).cueOutSec;
        const endSec = trimEndSec != null && durSec > 0
          ? Math.min(durSec, trimEndSec)
          : (trimEndSec ?? durSec);
        const windDownSec = endSec > 0 && Number.isFinite(outro.startMs)
          ? Math.max(0, endSec - outro.startMs / 1000)
          : null;
        // Body loudness for the tail-drop shaping — same resolution ladder as
        // applyLoudnessGain (track object first, else the library row).
        let bodyLufs = item.track.loudnessLufs;
        if (bodyLufs == null && item.track.id) bodyLufs = library.get(item.track.id)?.loudnessLufs ?? null;
        // Bar-snap to the TAIL tempo when measured — outros drift/ritard.
        const exitSecs = mix.endingCrossSecondsFor(
          { bpm: outro.bpm ?? next.bpm, key: next.key, ending: outro.ending },
          windDownSec,
          { maxSec, tailLufs: outro.lufs ?? null, bodyLufs, vocalTail: next.vocalTail },
        );
        if (exitSecs != null) {
          item.track.crossSec = exitSecs;
          const sung = next.vocalTail === true ? ', vocal tail' : '';
          this.log('mix', `exit canvas ${exitSecs}s (${outro.ending} ending${sung}) → ${item.track.title}`);
        }
      }
    }

    // Stem-blend seam (feature: stem-blend transitions): when the seam INTO
    // this pick is a pre-rendered clip, entry-side effects would garnish a
    // transition that no longer happens live — strip them before validation.
    // Exit-side gestures (washout/loop) stay: they shape THIS pick's own end,
    // which is still a live seam.
    if (item.stemSeam) {
      for (const k of ['sweep', 'blend', 'dissolve', 'chop'] as const) {
        if (item.track[k]) {
          delete item.track[k];
          this.log('mix', `${k} dropped (the seam into this pick is a rendered stem blend)`);
        }
      }
    }

    // The two flags are independent boundaries — sweep shapes ENTRY, washout
    // EXIT — so both can ride one pick and are validated separately. No cooldown
    // by design: pacing is the DJ's call, and the analyzer veto only judges
    // whether a sweep is musically wrong between locked tracks, never frequency.
    //
    // Anti-streak: the model imitates its own session history, so once it finds
    // a defensible favourite it repeats it mechanically (observed as all-normal,
    // then all-blend). The third consecutive IDENTICAL choice is stripped —
    // variety is a station rule, not a model virtue. The ledger tracks what the
    // model ASKED FOR, not what aired, so a stripped blend still evidences
    // monoculture and a stuck model stays stripped until it genuinely varies.
    // Auto (length-cap) washouts are deterministic, not choices, and are
    // invisible to the ledger in both directions.
    const choice: string | null =
      item.track.sweep ? 'sweep' : item.track.blend ? 'blend'
        : item.track.dissolve ? 'dissolve'
        : item.track.chop ? 'chop'
        : item.track.loop ? 'loop'
        : (item.track.washout && !item.track.washoutAuto) ? 'washout'
        : item.track.washoutAuto ? null : 'normal';
    const last2 = this._recentEffects.slice(-2);
    if (choice && choice !== 'normal' && last2.length >= 2 && last2.every(k => k === choice)) {
      this.stripEffect(item.track, `variety — third ${choice} in a row`);
    }
    if (choice) {
      this._recentEffects.push(choice);
      if (this._recentEffects.length > 4) this._recentEffects.shift();
    }
    // Entry-side effects (sweep/dissolve/chop) garnish the PREVIOUS track's
    // ending — a loop exit already armed on that track IS the transition, so
    // they all yield to it (radio.liq enforces the same precedence; stripping
    // here keeps the pick log honest). Loops are FIFO-armed on their own
    // applyMixTransition pass, so prevTrack.loop is already validated.
    if (item.track.sweep && prevTrack.loop) {
      delete item.track.sweep;
      this.log('mix', 'sweep dropped (previous track already exits through a loop)');
    }
    if (item.track.sweep && !mix.effectAllowedFor('sweep', cur, next)) {
      delete item.track.sweep;
      this.log('mix', 'sweep dropped (tracks too compatible — beat-blend beats a sweep)');
    }
    if (item.track.sweep) this.log('mix', `sweep armed → ${item.track.title}`);
    // blend is the sweep's mirror (entry-side, flagged on the incoming pick):
    // it only makes sense between COMPATIBLE tracks — the handover exposes a
    // clash rather than hiding it.
    if (item.track.blend && prevTrack.loop) {
      delete item.track.blend;
      this.log('mix', 'blend dropped (previous track already exits through a loop)');
    }
    if (item.track.blend && !mix.effectAllowedFor('blend', cur, next)) {
      delete item.track.blend;
      this.log('mix', 'blend dropped (tracks clash — a handover needs a compatible pair)');
    }
    if (item.track.blend) this.log('mix', `blend armed → ${item.track.title}`);
    // dissolve (reverb wash) — blend's mirror: beatless ambience only earns
    // its place across a measurable clash. Also yields to a washout already
    // riding the PREVIOUS track's exit: both gestures shape the same outgoing
    // ending (echo tail vs ambient wash), and the washout may carry the
    // length-cap auto-arm. radio.liq enforces the same precedence as a
    // belt-and-braces guard; stripping here keeps the pick log honest.
    if (item.track.dissolve && (prevTrack.washout || prevTrack.loop)) {
      delete item.track.dissolve;
      this.log('mix', `dissolve dropped (previous track already exits through a ${prevTrack.washout ? 'washout' : 'loop'})`);
    }
    if (item.track.dissolve && !mix.effectAllowedFor('dissolve', cur, next)) {
      delete item.track.dissolve;
      this.log('mix', 'dissolve dropped (tracks too compatible — a blend keeps the groove a wash would kill)');
    }
    if (item.track.dissolve) this.log('mix', `dissolve armed → ${item.track.title}`);
    // chop (crossfader cut) — the percussive clash move: the outgoing track is
    // gated rhythmically on its own beat, stabs thinning out as this pick rises
    // through the gaps. Entry-side like the sweep, so it needs no canvas — but
    // it DOES need a tempo: the gate period is one beat of the OUTGOING track
    // (the one being cut), stamped on this pick because the predecessor's
    // annotation has already been sent by the time this runs. Yields to a
    // washout riding the previous track's exit, same reasoning as the
    // dissolve: both gestures shape the same outgoing ending.
    if (item.track.chop && (prevTrack.washout || prevTrack.loop)) {
      delete item.track.chop;
      this.log('mix', `chop dropped (previous track already exits through a ${prevTrack.washout ? 'washout' : 'loop'})`);
    }
    if (item.track.chop && !mix.effectAllowedFor('chop', cur, next)) {
      delete item.track.chop;
      this.log('mix', 'chop dropped (tracks too compatible — a beat-blend beats a cut)');
    }
    if (item.track.chop) {
      item.track.chopPeriod = mix.chopPeriodFor(cur.bpm);
      this.log('mix', `chop armed: ${item.track.chopPeriod}s gate → ${item.track.title}`);
    }
    // loop (exit loop) — exit-side like the washout: THIS pick's last bar is
    // caught in a comb-cascade loop as it ends (see radio.liq's loop block
    // for the delay-tiling mechanics), riding under whatever follows before
    // it cuts away. Cross-duration physics puts everything on
    // the flagged track itself: its liq_cross_duration is the canvas, its
    // liq_loop_bar is one bar of its OWN tempo. The one hard data gate: the
    // loop needs the track's measured BPM — an arbitrary-length loop of an
    // unmeasured track is noise, not craft (editorial otherwise, like the
    // washout — the variety ledger rations it).
    if (item.track.loop && !(next.bpm && next.bpm > 0)) {
      delete item.track.loop;
      this.log('mix', 'loop dropped (no measured tempo — a loop needs a bar length)');
    }
    if (item.track.loop) {
      item.track.crossSec = mix.loopCrossSecondsFor(next, maxSec);
      item.track.loopBar = mix.loopBarFor(next.bpm);
      this.log('mix', `loop armed: ${item.track.crossSec}s canvas, ${item.track.loopBar}s bar → ${item.track.title}`);
    }
    if (item.track.washout) {
      item.track.crossSec = mix.washoutCrossSecondsFor(next, maxSec);
      item.track.washoutDelay = mix.washoutDelayFor(next.bpm);
      const why = item.track.washoutAuto ? ' (length-cap exit)' : '';
      this.log('mix', `washout armed${why}: ${item.track.crossSec}s canvas, ${item.track.washoutDelay}s tap → ${item.track.title}`);
    }
    const effectFired = !!(item.track.sweep || item.track.washout || item.track.blend || item.track.dissolve || item.track.chop || item.track.loop);

    // Feature 2 — transition FX, spaced by the chattiness ladder and gated on
    // settings.sfx.enabled; never two transitions in a row, and never a riser
    // over a sweep/washout transition. Only ARMED here: this runs at drain
    // time, right after the PREVIOUS track started — the crossfade this
    // stinger is sized for (prevTrack → item) is a full track away. Playing it
    // now (the original behaviour) landed a drum-roll a few seconds into a
    // song, apropos of nothing. onTrackStarted fires it when item airs, i.e.
    // while that crossfade is actually happening.
    this._transitionsSinceSfx++;
    if (!effectFired && settings.get().sfx?.enabled && this._transitionsSinceSfx >= this.sfxTransitionGap()) {
      const fx = mix.transitionSfxFor(cur, next);
      if (fx) {
        this._transitionsSinceSfx = 0;
        item.transitionSfx = fx;
        this.log('mix', `transition stinger armed (${fx}) → ${item.track.title}`);
      }
    }
  }

  // Seconds before the on-air track's EFFECTIVE end (min of tagged duration
  // and any cue_out stamped at its drain), or null when unknowable — boot,
  // recover, untracked auto plays. Null degrades every consumer to today's
  // eager behaviour (drain-policy.ts).
  remainingSecOnAir(): number | null {
    const cur = this.current;
    if (!cur?.startedAt) return null;
    const startedMs = Date.parse(cur.startedAt);
    let durSec = Number(cur.track?.duration) || 0;
    if (!durSec && cur.track?.id) durSec = Number(library.get(cur.track.id)?.durationSec) || 0;
    return remainingSec(
      Date.now(),
      Number.isFinite(startedMs) ? startedMs : null,
      durSec > 0 ? durSec : null,
      cur.cueOutSec ?? null,
      cur.cueInSec ?? null,
    );
  }

  // Seconds until ITEM airs: the on-air clock extended past every sent-but-
  // unaired item ahead of it in `upcoming`. An unknown length anywhere in the
  // chain makes the answer unknowable (null → callers take the safe path).
  // Live — call it again after any await; the sender's TTS/render waits can
  // stretch tens of seconds and a stale value overstates the real window.
  remainingUntilItemAirs(item: QueueItem): number | null {
    const idx = this.upcoming.indexOf(item);
    if (idx < 0) return null;
    let remaining = this.remainingSecOnAir();
    if (remaining == null || idx === 0) return remaining;
    for (const ahead of this.upcoming.slice(0, idx)) {
      if (!ahead.sent) continue; // unsent ahead items drain first anyway
      let d = Number(ahead.track?.duration) || 0;
      if (!d && ahead.track?.id) d = Number(library.get(ahead.track.id)?.durationSec) || 0;
      if (!d) return null;
      const playable = playableDurationSec(d, ahead.cueOutSec ?? null, ahead.cueInSec ?? null);
      if (playable == null) return null;
      remaining += playable;
    }
    return remaining;
  }

  // Whether pair-aware drains are in effect. The toggle is transitions.
  // pairDrain, but the feature only pays off under a DJ-mode persona — both
  // consumers of the hold (applyPairStamps, maybeRenderBlend) no-op without
  // djMode, so holding would cost dj_queue visibility (and a wider restart
  // window) for nothing. Non-DJ personas keep the eager drain byte-for-byte.
  pairDrainActive(): boolean {
    return settings.get().transitions?.pairDrain !== false
      && !!settings.getEffectivePersona()?.djMode;
  }

  // Basenames of rendered transition clips that haven't AIRED yet — the clip
  // rides its outgoing item's stemBlend stamp, and that item's clip airs at
  // the item's own END, so `current` counts as pending too (its clip is still
  // ahead while it plays). The hourly age sweep skips these: a clip behind a
  // long outgoing track (an uncapped listener-requested mix) can legitimately
  // out-age the sweep window while still queued in dj_queue.
  pendingClipPaths(): Set<string> {
    const names = new Set<string>();
    const collect = (i: { stemBlend?: { clipPath: string } | null } | null | undefined) => {
      if (i?.stemBlend?.clipPath) names.add(basename(i.stemBlend.clipPath));
    };
    collect(this.current);
    for (const u of this.upcoming) collect(u);
    return names;
  }

  // Pair-sized exit blend (#749): with the successor known at drain time, size
  // THIS track's own exit crossfade for the actual pair — compatibility curve,
  // daypart nudge, bar-snap, capped to the successor's instrumental intro.
  //
  // Precedence: washout/loop own their canvases outright (their physics stamped
  // them), and applyMixTransition's ending-aware canvas is narrowed, never
  // widened — the pair value wins only when SHORTER, so a cold ending's tight
  // cut survives a clash's long wash and a measured fade never doubles under a
  // locked pair's 4s blend.
  applyPairStamps(item: QueueItem, successor: QueueItem) {
    if (!settings.getEffectivePersona()?.djMode) return;
    if (item.track.washout || item.track.loop) return;
    const cur = this.mixAnalysisFor(item.track);
    const next = this.mixAnalysisFor(successor.track);
    let energyDelta = 0;
    try { energyDelta = energyForDaypart().speed - 1; } catch { /* context optional */ }
    let nextIntroMs = successor.track.introMs;
    if (nextIntroMs == null && successor.track.id) nextIntroMs = library.get(successor.track.id)?.introMs ?? null;
    // Onto the trimmed timeline: the blend is sized against the runway the
    // successor will actually have on air, not the one its file starts with.
    nextIntroMs = silenceTrim.shiftOnsetMs(successor.track, nextIntroMs);
    const maxSec = settings.get()?.crossfadeDuration ?? null;
    const secs = mix.crossSecondsFor(cur, next, { energyDelta, nextIntroMs, maxSec });
    if (secs == null) return;
    const existing = item.track.crossSec;
    item.track.crossSec = existing != null ? Math.min(existing, secs) : secs;
    this.log('mix', `pair blend ${item.track.crossSec}s: ${item.track.title} → ${successor.track.title}`
      + (existing != null && existing < secs ? ' (ending canvas kept)' : ''));
  }

  // Walk the upcoming queue and feed unsent items to Liquidsoap one at a time,
  // spaced out so the 1s file-poll doesn't miss any.
  //
  // Pair-aware hold (feature: pair-aware transitions — the #749 fix, see
  // drain-policy.ts): a track's annotate stamps control the transition at its
  // OWN end, so the tail item is held unsent until its successor is queued
  // behind it (any successor — an agent pick or a listener request equally: a
  // request arriving IS the successor arriving, so FIFO is never inverted by
  // draining around a held item). The watcher tick re-runs this as the clock
  // advances; past the hard deadline the item drains with track-intrinsic
  // stamps only. transitions.pairDrain off → eager drain, today's behaviour.
  async drainToLiquidsoap(force = false) {
    if (this.senderBusy) {
      // A forced drain (the clip-as-track recovery) must not vanish into a
      // busy sender — a stem-blend render or a slow TTS engine can hold the
      // mutex for tens of seconds, and "force" promises never to hold.
      // Single-flight stays single: flag it and the in-flight drain re-runs
      // forced the moment it releases.
      if (force) this.pendingForceDrain = true;
      return;
    }
    this.senderBusy = true;
    try {
      while (true) {
        const item = this.upcoming.find(i => !i.sent);
        if (!item) break;

        const idx = this.upcoming.indexOf(item);
        const hasSuccessor = idx >= 0 && idx + 1 < this.upcoming.length;
        // The clock that governs THIS item's drain is the end of the track it
        // will FOLLOW — the on-air track extended past any sent-but-unaired
        // items ahead (remainingUntilItemAirs). Without the extension, the
        // freshly-picked next-NEXT item drained at every track boundary (the
        // on-air clock hit zero) and every other seam lost its pair stamps —
        // caught live in the first on-air smoke test.
        // `force` is the clip-as-track recovery path (onTrackStarted's guard):
        // never hold, but a known successor still earns its pair stamps.
        const action = force
          ? (hasSuccessor ? 'send-pair' : 'send-intrinsic')
          : drainAction({
              pairDrain: this.pairDrainActive(),
              hasSuccessor,
              remainingSec: this.remainingUntilItemAirs(item),
            });
        if (action === 'hold') break;

        // Render the track's intro/link WAV ahead of time but DON'T air it here
        // — airing now would play it over whatever's currently on-air, one (or
        // more) tracks before this one reaches the front of dj_queue (issue
        // #189). airIntro() writes it to the voice file when the track starts.
        // Skipped while the station voice is off: airIntro would only drop the
        // WAV (the script predates the flip), so the render is pure waste — and
        // if the switch comes back on before the track airs, airIntro renders
        // from the script itself.
        //
        // The render is BUDGETED against the same clock the drain verdict used
        // (#1409). The verdict only decides "send"; the music isn't committed
        // until the writeHandoff far below, and a slow local TTS engine can
        // burn the whole remaining runway right here — the seam then falls to
        // auto.m3u and this pick airs one track late. Music commitment is not
        // allowed to sit behind optional speech: past the budget the drain
        // moves on and airIntro renders from the script at air time.
        //
        // A deferred render also costs this link its bed — maybePushBed needs
        // a WAV to measure the line against, so it no-ops and a long link airs
        // over the song's intro under the light duck (pre-bed behaviour). That
        // is the accepted price of the trade: a naked link is a garnish lost,
        // a missed seam is the wrong track on air.
        if (item.introScript && !item.introWav && autoVoiceAllowed()) {
          const budgetSec = introRenderBudgetSec(this.remainingUntilItemAirs(item));
          if (budgetSec === 0) {
            this.log('mix', `Intro render deferred to air time — "${item.track.title}" airs too soon to render ahead`);
          } else {
            // Settle handlers are attached to the render promise ITSELF, not to
            // the race: a render that lands after the budget still reaches the
            // item (airIntro then finds a WAV instead of re-rendering), and a
            // late rejection can never surface as an unhandled rejection.
            const render = this._introRenders.start(item, () => speak(item.introScript!, {
              kind: item.introKind || 'dj-speak',
              // Voice it as whoever wrote it. Without this, speak() falls back
              // to getEffectivePersona() at DRAIN time — minutes after the line
              // was written, possibly the other side of a show boundary.
              persona: item.introPersona || null,
            }));
            // The tracker turns rejection into a result so a late failure can
            // never surface unhandled. This observer owns the item mutation and
            // error log even after the drain stops waiting.
            void render.then(result => {
              if (result.status === 'rendered') {
                if (!item.introAired) item.introWav = result.wav;
              } else {
                this.log('error', `TTS failed: ${(result.error as Error).message}`);
              }
            });
            const result = await awaitIntroRender(
              render,
              budgetSec == null ? null : budgetSec * 1000,
            );
            if (result.status === 'timed-out') {
              this.log('mix', `Intro render overran its ${Math.round(budgetSec!)}s window — committing "${item.track.title}" now, voice follows at air time`);
            }
          }
        }

        // An operator cancel (removeUpcoming) may have spliced this item out
        // while we were awaiting the TTS render above — don't hand a removed
        // track to Liquidsoap.
        if (!this.upcoming.includes(item)) continue;

        // DJ-mode mixing (features 1 & 2): shape the transition INTO this track
        // from its tempo/harmonic compatibility with the track it follows. The
        // predecessor is the item just ahead of it in the queue, else whatever
        // is on-air now. Both gated on the active persona's djMode and on both
        // tracks being analysed — a no-op otherwise, so non-DJ stations and
        // un-analysed libraries behave exactly as before.
        this.applyMixTransition(item);

        // Loudness normalisation (feature: LUFS gain) — applies to EVERY track,
        // not just DJ mode. Resolve the track's integrated loudness (ReplayGain
        // tag first by default — see applyLoudnessGain — else the measured
        // value from the item or a library lookup) and stash a clamped gain
        // offset toward the target; subsonic.getAnnotatedUri folds it into
        // liq_amplify. No loudness from any source → no liq_amplify → unity.
        await this.applyLoudnessGain(item.track);

        // Hard length cap (#447): stamp a cue_out so Liquidsoap cuts an
        // over-length autonomous pick mid-air. Listener requests stay exempt —
        // a requested long mix plays in full, mirroring the picker tools'
        // selection-cap exemption.
        //
        // Then the bed, if this item's link would outlast the song's own intro.
        // dj_queue is FIFO, so it must be handed over BEFORE the track URI below.
        await this.maybePushBed(item);

        const maxDurationSec = item.requestedBy ? null : settings.effectiveMaxTrackSec();
        const itemDurSec = knownDurationSec(item.track);
        const cappedExit = !!(maxDurationSec && itemDurSec > maxDurationSec);

        // Dead-air trim: cut the near-silent head/tail off this track so a bad
        // rip's leading blank doesn't air as silence. Resolved through the
        // policy module, never inlined — the auto.m3u rewrite asks the same
        // question and the two must not drift. Off / unmeasured → nulls, i.e.
        // no cue stamps and today's behaviour.
        //
        // Resolved HERE, above the stem-blend attempt, because the blend is
        // rendered FROM the two regions the trim can remove and has to be told.
        const trim = silenceTrim.resolveSilenceTrim(item.track);

        // Pair stamps for THIS item's own exit (the seam into its successor)
        // — only when the successor is known at annotate time. Resolved fresh
        // after the awaits above: an operator cancel during the TTS render
        // may have removed the successor, in which case the item just drains
        // with its intrinsic stamps.
        let successor: QueueItem | null = null;
        if (action === 'send-pair') {
          successor = this.upcoming[this.upcoming.indexOf(item) + 1] ?? null;
          if (successor) {
            this.applyPairStamps(item, successor);
            // Stem-blend seam (feature: stem-blend transitions): with the
            // pair known, try to upgrade this seam to a pre-rendered blend.
            // Cache-hit-only + deadline-raced inside; null → the plain
            // pair-aware crossfade just stamped above.
            try {
              // The render's window is the ahead-extended clock (time until
              // THIS item's predecessor ends) — recomputed HERE, not reused
              // from the hold decision above: the TTS await between them can
              // run tens of seconds on a slow engine, and a stale window
              // would let the render overrun the drain's hard fallback.
              // Both trim edges are blend vetoes, for the same reason
              // outCapped is: the clip is mixed FROM the outgoing tail and the
              // incoming head, so a cut that lands inside either region makes
              // the rendered seam describe audio that no longer airs. The
              // incoming side is the sharper one — a successor's leading blank
              // is baked into the clip, so the blend would air the very silence
              // the trim exists to remove.
              const inTrim = silenceTrim.resolveSilenceTrim(successor.track);
              const blend = await stemBlend.maybeRenderBlend(
                item.track, successor.track, this.remainingUntilItemAirs(item), {
                  outCapped: cappedExit,
                  outTrimEndSec: trim.cueOutSec,
                  inHeadTrimmed: inTrim.cueInSec != null,
                },
              );
              if (blend && this.upcoming.includes(item) && this.upcoming.includes(successor)) {
                // The rendered seam owns this ending: strip exit gestures
                // (their canvases would fight the clip) and cut tight into
                // the clip. Entry-side flags on ITEM are untouched — they
                // garnish the seam INTO it, which already aired its stamps.
                delete item.track.washout;
                delete item.track.washoutAuto;
                delete item.track.washoutDelay;
                delete item.track.loop;
                delete item.track.loopBar;
                item.track.crossSec = stemBlend.CLIP_SEAM_CROSS_SEC;
                item.stemBlend = blend;
                item.cueOutSec = blend.blendStartSec;
                successor.stemSeam = true;
                successor.stemCueInSec = blend.inCueSec;
                this.log('mix', `stem blend armed: ${item.track.title} ✕ ${successor.track.title} (cut ${blend.blendStartSec}s, cue-in ${blend.inCueSec}s, clip ${blend.clipSec}s)`);
              }
            } catch (err) {
              this.log('error', `Stem blend failed (falling back to plain crossfade): ${(err as Error).message}`);
            }
          }
        }

        // Record the effective early end for the pair-drain deadline math —
        // rides into `current` when the item airs (onTrackStarted spreads it).
        // Both early ends fold in: the length cap and the trimmed tail shorten
        // the track for the SAME reason as far as the seam clock is concerned,
        // and a deadline computed off the untrimmed length would hand over
        // late by exactly the silence we just cut.
        if (cappedExit) item.cueOutSec = Math.min(item.cueOutSec ?? Infinity, maxDurationSec!);
        if (trim.cueOutSec != null) item.cueOutSec = Math.min(item.cueOutSec ?? Infinity, trim.cueOutSec);
        // Stem-seam cue points: the blend's cut on the way out, the clip's
        // hand-off on the way in (stamped when the INCOMING item drains).
        // Per-attempt identity for proto_subhttp's explicit completion signal.
        // A URL fragment carries it to Liquidsoap but is never sent to the
        // Navidrome origin by curl. Local-file handoffs never enter that
        // protocol, so do not poll a completion channel they cannot produce.
        item.resolveProbeId = subsonic.getLocalPath(item.track)
          ? undefined
          : randomBytes(8).toString('hex');
        // A rendered blend's cut and the trimmed tail are both "stop early";
        // whichever comes first wins, exactly as getAnnotatedUri already
        // arbitrates those against the #447 cap. On the way in, the stem
        // seam's cue-in is DEEPER into the track than any leading silence (the
        // clip already played that head), so the later of the two is the one
        // that leaves no audio played twice.
        const cueOutCandidates = [item.stemBlend?.blendStartSec, trim.cueOutSec]
          .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
        const cueInCandidates = [item.stemSeam ? item.stemCueInSec : null, trim.cueInSec]
          .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
        item.cueInSec = cueInCandidates.length ? Math.max(...cueInCandidates) : undefined;
        const uri = subsonic.getAnnotatedUri(item.track, {
          maxDurationSec,
          cueOutSec: cueOutCandidates.length ? Math.min(...cueOutCandidates) : null,
          cueInSec: item.cueInSec ?? null,
          resolveProbeId: item.resolveProbeId,
        });
        if (trim.cueInSec != null || trim.cueOutSec != null) {
          this.log('mix', `silence trimmed on "${item.track.title}"${trim.cueInSec != null ? ` head ${trim.cueInSec}s` : ''}${trim.cueOutSec != null ? ` tail from ${trim.cueOutSec}s` : ''}`);
        }
        // Queue-file writes wait longer than the default 1.5s: with a clip
        // following, two back-to-back writes are the norm and one missed
        // 1.0s poll must not overwrite an unconsumed handoff.
        await writeHandoff(config.liquidsoap.queueFile, uri, { maxWaitMs: 5000 });
        if (item.stemBlend) {
          // The clip rides right behind its outgoing track, annotated as the
          // INCOMING track so now-playing flips when the blend begins. Reuse
          // the successor the blend was rendered FOR — NOT a fresh index
          // lookup: the writeHandoff above can wait seconds, and an operator
          // cancel in that window would land the clip's annotation on
          // whatever item slid into the slot (the clip would air carrying an
          // unrelated track's identity).
          if (successor && this.upcoming.includes(successor)) {
            const clipUri = subsonic.getClipUri(successor.track, item.stemBlend.clipPath, stemBlend.CLIP_SEAM_CROSS_SEC);
            await writeHandoff(config.liquidsoap.queueFile, clipUri, { maxWaitMs: 5000 });
          } else {
            // Successor cancelled between the render and the clip write: skip
            // the clip. The early cue_out already annotated on the outgoing
            // track airs as the accepted abrupt-but-crossfaded exit; dropping
            // the flag keeps the sweep's keep-set and the cancel cascade
            // honest about "no clip queued".
            delete item.stemBlend;
            this.log('mix', `stem-blend successor cancelled mid-handoff — clip skipped; "${item.track.title}" exits early into a plain crossfade`);
          }
        }
        item.sent = true;
        this.persist();  // record the sent flag — these are now live in dj_queue

        // `sent` means "handed over", NOT "playable": Liquidsoap drops a
        // request it cannot resolve, and nothing else tells the controller
        // (#1405). Probe dj_queue for this id and re-pick at once if the push
        // evaporated. Fire-and-forget — it sleeps between reads and must not
        // hold the sender mutex.
        void this.verifyPushResolved(item);

        // writeHandoff already waited for Liquidsoap's poll to consume the
        // file before returning, so no extra sleep needed here.
      }
    } finally {
      this.senderBusy = false;
      if (this.pendingForceDrain) {
        this.pendingForceDrain = false;
        void this.drainToLiquidsoap(true);
      }
    }
  }

  // Commit the queued pick to Liquidsoap before an operator skip (#1300 bug 6).
  // Under pair-aware drain the held pick isn't in dj_queue for most of a track's
  // runtime, so a bare telnet skip falls through to the randomized auto playlist
  // while the admin queue shows a different "next". Force-drain whatever is
  // held, then wait for the dj_queue_status probe to report a RESOLVED request
  // (a sent-but-still-downloading one loses the fallback race just the same),
  // bounded by SKIP_COMMIT_WAIT_MS. Past it the skip proceeds anyway — ending
  // THIS track is the operator's intent — and the caller reports the miss
  // honestly. Never throws: a skip must not fail on its safety net.
  async commitBeforeSkip(): Promise<{ pending: boolean; committed: boolean; waitedMs: number }> {
    if (skipPrepAction(this.upcoming.length) === 'skip-now') {
      return { pending: false, committed: false, waitedMs: 0 };
    }
    const t0 = Date.now();
    // One forced kick covers every held item; a busy sender re-runs it forced
    // on release (pendingForceDrain), so the loop below only observes.
    void this.drainToLiquidsoap(true);
    let headSentAt: number | null = null;
    const deadline = t0 + SKIP_COMMIT_WAIT_MS;
    while (true) {
      const head = this.upcoming[0];
      if (!head) {
        // Everything aired or was cancelled while waiting — nothing left to
        // protect, the skip falls through honestly.
        return { pending: false, committed: false, waitedMs: Date.now() - t0 };
      }
      if (head.sent) {
        if (headSentAt == null) headSentAt = Date.now();
        const status = await liquidsoapControl.djQueueStatus();
        if (commitSatisfied({ headSent: true, queueStatus: status, sinceHeadSentMs: Date.now() - headSentAt })) {
          return { pending: true, committed: true, waitedMs: Date.now() - t0 };
        }
      }
      if (Date.now() + SKIP_POLL_INTERVAL_MS > deadline) break;
      await sleep(SKIP_POLL_INTERVAL_MS);
    }
    return { pending: true, committed: false, waitedMs: Date.now() - t0 };
  }

  // Speak something without queueing a track — hourly time checks, weather,
  // station IDs, auto-DJ links. Two Liquidsoap voice channels, picked by kind:
  //   - 'link' → intro.txt → intro_queue → LIGHT duck (talk-over feel: the song
  //              that just started stays audible under the voice)
  //   - else   → say.txt   → voice_queue → HEAVY duck (solo voice dominates)
  //
  // `opts.persona` overrides the on-air persona for THIS clip — the mic-pass
  // voices the OUTGOING DJ after the hour has flipped (dj-agent.runPersonaHandoff).
  // `opts.meta` is merged into the session turn, e.g. tagging the sign-off with
  // the outgoing persona id.
  async announce(text, kind = 'announcement', { persona = null, meta = {} }: { persona?: Persona | null; meta?: TurnMeta } = {}) {
    if (!text || !text.trim()) return;
    try {
      const wavPath = await speak(text, { kind, persona });
      // No bed here by construction — announce() speaks without queueing a
      // track, so there is nothing for maybePushBed to have bedded.
      const channel = voiceChannelFor(kind);
      const targetFile = channel === 'intro'
        ? config.liquidsoap.introFile
        : config.liquidsoap.sayFile;
      const seg: SegmentDesc = { kind, channel, text, meta, persona };
      const handoff = await airVoice(targetFile, wavPath, text, voiceGainDb(kind, persona), {
        onQueued: q => this.onQueued(q, seg),
      });
      // Bookkeeping runs when the words reach the stream, not when the file was
      // handed over (#1382) — the same rule announceAtNextTrack already states:
      // the DJ's memory, and everything downstream of it, should reflect what
      // aired. On a mixer that writes no marker this resolves immediately with a
      // null stamp, which is byte-for-byte the old timing.
      this.onSpoken(handoff, seg);
    } catch (err) {
      this.log('error', `Announce failed: ${(err as Error).message}`);
    }
  }

  // Everything a spoken segment owes once it is ON AIR, run from the one place
  // that knows when that happened (#1382).
  //
  // The four sites that air a segment (announce, announceExchange,
  // airPendingVoice, airIntro) all used to do this inline, immediately after the
  // handoff file was written — which is a poll, a queue and a duck ramp before
  // any of it is true. They also drifted: three published slightly different
  // webhook payloads for the same thing.
  //
  // `handoff.aired` resolves with the live-edge stamp from the mixer's marker,
  // or immediately with null on a station whose Liquidsoap doesn't write one —
  // in which case this is exactly the old timing and the old (unstamped) data.
  // It never rejects, so there is no path where a segment airs and the booth log
  // never hears about it.
  // The pre-air half of the same bookkeeping: announce that speech is COMING.
  // Passed to airVoice as a callback because the commitment happens inside it,
  // before the handoff this method's caller is awaiting has resolved — the
  // whole value of the event is that it lands early. Nothing is logged or
  // persisted here: this is a forecast, and the booth log records what aired.
  onQueued(q: QueuedVoice, { kind, channel, text, meta = {}, persona = null }: SegmentDesc) {
    try {
      notifyQueued({
        voiceId: q.voiceId,
        kind,
        channel,
        text,
        durationMs: q.clipMs,
        estimatedAirInMs: q.estimatedAirInMs,
        personaId: persona?.id ?? (meta.personaId as string | undefined) ?? null,
        personaName: persona?.name ?? (meta.personaName as string | undefined) ?? null,
      });
    } catch (err) {
      this.log('error', `Queued-voice notify failed: ${(err as Error).message}`);
    }
  }

  onSpoken(handoff: VoiceHandoff, {
    kind, channel, text, meta = {}, persona = null, logText = null, legacy = true,
  }: SegmentDesc) {
    void handoff.aired.then(airedAt => {
      try {
        this.log(kind, logText ?? text);
        session.appendTurn({
          role: 'segment',
          kind,
          text,
          // Live-edge, like every other timestamp the controller publishes: a
          // player showing this line to a LISTENER has to add
          // stream.bufferSeconds on top (#1114). Absent when unmeasured, so a
          // consumer can tell "not known" from "aired at the epoch".
          meta: airedAt != null
            ? { ...meta, airedAt: new Date(airedAt).toISOString() }
            : meta,
        });
        notifySpoken({
          voiceId: handoff.voiceId,
          kind,
          channel,
          text,
          durationMs: handoff.clipMs,
          airedAt,
          legacy,
          personaId: persona?.id ?? (meta.personaId as string | undefined) ?? null,
          personaName: persona?.name ?? (meta.personaName as string | undefined) ?? null,
        });
      } catch (err) {
        this.log('error', `Post-air bookkeeping failed: ${(err as Error).message}`);
      }
    });
  }

  // Air a short multi-voice exchange (guest-show banter): every line renders
  // to a WAV FIRST — all-or-nothing, so a TTS failure can't strand half a
  // conversation on air — then the clips go to the serialized say.txt voice
  // chain back-to-back (airVoice holds the shared lock for each clip's
  // playback, so line N+1 lands as line N finishes; the same mechanism that
  // makes the two-voice persona handoff play cleanly). Each line is booth-
  // logged speaker-prefixed and appended to the session tagged with its
  // speaker, so windowMessages names a guest's words as theirs.
  async announceExchange(lines: { persona: Persona; text: string }[], kind = 'banter') {
    const rendered: { persona: Persona; text: string; wavPath: string }[] = [];
    try {
      for (const l of lines) {
        const wavPath = await speak(l.text, { kind, persona: l.persona });
        rendered.push({ ...l, wavPath });
      }
    } catch (err) {
      this.log('error', `Exchange render failed: ${(err as Error).message}`);
      return false;
    }
    for (const l of rendered) {
      try {
        const seg: SegmentDesc = exchangeSegment(l, kind);
        const handoff = await airVoice(config.liquidsoap.sayFile, l.wavPath, l.text, voiceGainDb(kind, l.persona), {
          onQueued: q => this.onQueued(q, seg),
        });
        this.onSpoken(handoff, seg);
      } catch (err) {
        this.log('error', `Exchange line failed to air: ${(err as Error).message}`);
      }
    }
    // One webhook for the whole exchange — per-line events would read as five
    // separate segments to a Discord pipe.
    webhooks.notify('dj.say', {
      text: rendered.map(l => `${l.persona?.name || 'DJ'}: ${l.text}`).join('\n'),
      kind,
    });
    return true;
  }

  // Defer a spoken segment to the NEXT track boundary. Used for station idents:
  // unlike the hourly time check they have no real-time constraint, so ducking
  // the current song mid-vocal at an arbitrary minute is pure loss, where at a
  // transition the same ident lands like real radio. The WAV renders NOW (TTS
  // latency off the air path) and onTrackStarted airs it via the light-duck
  // intro channel.
  //
  // One slot only: a newer pending segment replaces an unaired older one, so a
  // fresh ident supersedes a stale one rather than stacking. All bookkeeping
  // (djLog → recap/opener anti-repeat, session turn, webhook) happens at AIR
  // time, so the DJ's memory reflects what reached the stream, not what was
  // merely scheduled.
  async announceAtNextTrack(text, kind = 'announcement', { persona = null, meta = {}, daypart = null }: { persona?: Persona | null; meta?: TurnMeta; daypart?: string | null } = {}) {
    if (!text || !text.trim()) return;
    try {
      const wavPath = await speak(text, { kind, persona });
      this._pendingVoice = { text, kind, wavPath, persona, meta, daypart, t: Date.now() };
      this.log('scheduler', `Holding ${kind} for the next track boundary`);
    } catch (err) {
      this.log('error', `Deferred announce failed: ${(err as Error).message}`);
    }
  }

  // Discard a scheduled-but-unaired deferred segment. A mic-pass supersedes an
  // ident: sign-off + greeting name the station, the outgoing show and the
  // incoming one, so an ident in front of it is three spoken segments in a row
  // saying overlapping things. The next cron fire schedules a fresh ident.
  dropPendingVoice(reason: string) {
    const p = this._pendingVoice;
    if (!p) return;
    this._pendingVoice = null;
    this.log('scheduler', `Dropped pending ${p.kind} — ${reason}`);
  }

  // Index in `upcoming` of the item Liquidsoap is now reporting, or -1. Matched
  // by subsonic_id first (reliable), falling back to title+artist for older
  // items that pre-date the id annotation. Extracted from onTrackStarted so
  // airPendingVoice can look at the SAME incoming item that tick is about to
  // consume, without a second matcher drifting out of step with this one.
  matchUpcomingIndex(np: NowPlaying | null): number {
    if (!np) return -1;
    let idx = -1;
    if (np.subsonic_id) {
      idx = this.upcoming.findIndex(u => u.track.id && u.track.id === np.subsonic_id);
    }
    if (idx < 0) {
      idx = this.upcoming.findIndex(
        u => u.track.title === np.title && (u.track.artist || '') === (np.artist || '')
      );
    }
    return idx;
  }

  // Air the boundary-deferred segment, if one is pending. Called from
  // onTrackStarted the moment a new track starts — but NOT at every boundary:
  // one that already carries the track's own link/intro belongs to that line
  // alone (#1258), and the ident holds for the next one instead.
  // The prompt context bakes in the local clock, so a clip that waited past
  // PENDING_VOICE_MAX_AGE_MS (a long mix, a stream stall, a long run of
  // link-carrying boundaries) is dropped rather than aired with a stale time
  // reference — the next cron fire replaces it.
  async airPendingVoice(np: NowPlaying | null = null) {
    // A mic-pass is already pending from an earlier roll (the hourly cron rolls
    // without airing) and will take this boundary. The same-tick case — where
    // the roll happens in onTrackStarted's auto-pick block, AFTER this runs —
    // is caught by the matching dropPendingVoice call over there.
    if (session.pendingHandoff()) {
      this.dropPendingVoice('the show handoff covers this boundary');
      return;
    }
    const p = this._pendingVoice;
    if (!p) return;
    // Staleness first: a clip too old to air is dropped outright rather than
    // held again below, so a busy stretch can't keep re-deferring a dead ident.
    if (Date.now() - p.t > PENDING_VOICE_MAX_AGE_MS) {
      this.dropPendingVoice('waited too long for a track boundary');
      return;
    }
    // A daypart offered at generation can cross its boundary while the WAV
    // waits here (for example, an ident written at 17:45 airing after 18:00).
    // The rendered words cannot be corrected, so apply the same fail-silent
    // trade as the pick-link clock drift guard. No stamp means the ident was
    // written with no permitted clock claim and remains eligible.
    const liveDaypart = getClockContext().spokenDaypart;
    if (stationIdDaypartDrifted(p.daypart, liveDaypart)) {
      this.dropPendingVoice(`daypart changed from "${p.daypart}" to "${liveDaypart}" before air`);
      return;
    }
    // This boundary already speaks. The track's own line is tied to THIS song
    // and can't be moved; the ident is generic, so it keeps its slot and takes
    // the next boundary — with a whole track of music in between, which is the
    // entire point. Nothing is regenerated: the rendered WAV just waits.
    // voiceAllowed/wavExists cover airIntro's own drop paths — a boundary whose
    // line airIntro will drop (voice switch off, WAV reaped with no script) is
    // silent, so holding for it would trade one voice for none. Both checks are
    // synchronous, keeping the decision ahead of this function's first await.
    const incoming = this.upcoming[this.matchUpcomingIndex(np)] || null;
    if (boundaryCarriesTrackVoice(incoming, this.current?.track || null, {
      voiceAllowed: autoVoiceAllowed(),
      wavExists: path => existsSync(path),
      nowMs: Date.now(),
    })) {
      this.log('scheduler',
        `Holding ${p.kind} — the track's own ${KIND_LABEL[incoming!.introKind || 'dj-speak'] || 'intro'} takes this boundary`);
      return;
    }
    this._pendingVoice = null;
    if (!existsSync(p.wavPath)) return;
    try {
      // Deferred idents ride the INTRO file (light duck at a track boundary),
      // whatever their kind — see announceAtNextTrack.
      const seg: SegmentDesc = { kind: p.kind, channel: 'intro', text: p.text, meta: p.meta, persona: p.persona };
      const handoff = await airVoice(config.liquidsoap.introFile, p.wavPath, p.text, voiceGainDb(p.kind, p.persona), {
        onQueued: q => this.onQueued(q, seg),
      });
      this.onSpoken(handoff, seg);
    } catch (err) {
      this.log('error', `Air pending voice failed: ${(err as Error).message}`);
    }
  }

  // Air a queued item's track-tied intro/link. Called from onTrackStarted the
  // moment the item's track actually starts playing, so the voice lands over
  // the RIGHT song rather than over whatever was on-air when it was queued
  // (issue #189). The WAV was rendered ahead of time in drainToLiquidsoap, so
  // this just writes the path to the duck channel and mirrors the bookkeeping
  // announce() does (djLog feeds the opener anti-repeat; session + webhook).
  // `overBed` is the CALLER's statement that an instrumental bed is feeding the
  // music chain right now — onBedStarted saw the marker. It is not read off
  // item.bedded, which only means a bed URI reached next.txt: a pushed item is
  // handed over, never playable (a URI Liquidsoap can't resolve is dropped in
  // silence, and a marker missed by more than BED_MARKER_FRESH_MS never fires
  // the event). In that case the song itself starts and onTrackStarted airs the
  // line over ITS opening — which is a song to talk over, so it takes the heavy
  // duck like any other request intro. Inferring the channel from the flag
  // would hand the one failure case this feature exists to prevent a LIGHTER
  // duck than it had before #1465. Same rule as onSpoken's channel: passed by
  // whoever knows, never re-derived (#1382).
  async airIntro(item: QueueItem, predecessor: Track | null = null, { overBed = false }: { overBed?: boolean } = {}) {
    // Station voice off (settings.tts.enabled). The generation sites already
    // skip writing intros, so this only catches an item queued BEFORE the
    // switch was flipped — it must not air its script now. Backstop, not the
    // policy: nothing here spends tokens, so a plain drop is the whole job.
    if (!autoVoiceAllowed()) return;
    if (!item || item.introAired) return;
    if (!item.introWav && !item.introScript) return;
    item.introAired = true;
    // Stale back-announce safety-net. Links are written forward-looking (intro
    // the pick, never name the just-played track), so this normally never fires.
    // It catches the model disobeying: if the rendered line actually NAMES a
    // track (`linkPrev`) that a listener request bumped out of the just-played
    // slot after the link was rendered, the baked-in "that was X" now names a
    // track one (or more) older than reality. We can't re-cut rendered audio, so
    // drop it — silence on this one hand-off beats airing a wrong name. A
    // forward-looking line that doesn't name the previous track airs regardless.
    if (shouldDropStaleLink(item, predecessor)) {
      this.log('link-skip',
        `Dropped stale link before "${item.track?.title}" — it named "${item.linkPrev!.title}" but "${predecessor?.title || 'another track'}" actually played first`);
      this.persist();
      return;
    }
    // Stale-CLOCK safety-net, the same trade one line up (#1314). A link is
    // only stamped with linkClockAt when the generator handed the model a time
    // to speak; if this seam lands far from that forecast — the pick missed the
    // slot it was written for and aired at the end of an auto.m3u filler
    // instead — the line names a time that has been and gone. The audio is
    // already cut, so drop it.
    if (linkClockDrifted(item.linkClockAt, Date.now())) {
      const driftSec = Math.round((Date.now() - item.linkClockAt!) / 1000);
      this.log('link-skip',
        `Dropped link before "${item.track?.title}" — written to air at ${new Date(item.linkClockAt!).toISOString()}, `
        + `but this seam is ${Math.abs(driftSec)}s ${driftSec > 0 ? 'later' : 'earlier'}, so any clock it states is wrong`);
      this.persist();
      return;
    }
    // Two ways the WAV can be missing: the voice reaper deletes clips older
    // than ~1h, so a long-form predecessor outlives the file; or it was never
    // rendered, because the drain skips the render while the station voice is
    // off and this item lived to air after the switch came back on. A silent
    // return would lose the link, and a bedded item would air its bed naked. The
    // script is still on the item either way, so render it now — introAired is
    // set above, so this can't double-air.
    if (!item.introWav || !existsSync(item.introWav)) {
      if (!item.introScript) return;
      // The drain may have stopped WAITING for this pre-render to protect the
      // music seam. Reuse that one TTS job at air time: local workers process
      // requests serially, so starting it again would queue a duplicate behind
      // the original; cloud engines would bill the same line twice.
      const pending = this._introRenders.get(item);
      if (pending) {
        const result = await pending;
        if (result.status === 'rendered') item.introWav = result.wav;
      }
    }
    if (!item.introWav || !existsSync(item.introWav)) {
      if (!item.introScript) return;
      try {
        item.introWav = await speak(item.introScript, {
          kind: item.introKind || 'dj-speak',
          // Same persona the script was written under — speak() would
          // otherwise resolve getEffectivePersona() at AIR time, the wrong
          // voice when this render lands the other side of a show boundary
          // (the drain-time render pins it for exactly that reason).
          persona: item.introPersona || null,
        });
      } catch (err) {
        this.log('error', `Intro WAV render at air time failed: ${(err as Error).message}`);
        return;
      }
    }
    const kind = item.introKind || 'dj-speak';
    // Channel is chosen by what this clip is playing OVER, not by its kind —
    // the same split the boundary-deferred ident already relies on (#1382).
    // `overBed` comes from onBedStarted, which SAW the bed start; see
    // voiceChannelFor for why it can't be read off item.bedded here.
    const channel = voiceChannelFor(kind, { overBed });
    const targetFile = channel === 'intro'
      ? config.liquidsoap.introFile
      : config.liquidsoap.sayFile;
    try {
      // Same persona the WAV was rendered under (see drainToLiquidsoap) — the
      // gain trim is per-persona, so re-resolving here would apply one DJ's
      // trim to another DJ's audio. This was the last voiceGainDb call site
      // still resolving from the wall clock.
      const seg: SegmentDesc = {
        kind,
        channel,
        text: item.introScript!,
        persona: item.introPersona || null,
        // Attribute the turn so windowMessages() can name the real speaker when
        // it wasn't the session's own persona (a link written by the outgoing
        // DJ airing just after the roll).
        meta: item.introPersona
          ? { personaId: item.introPersona.id, personaName: item.introPersona.name }
          : {},
      };
      const handoff = await airVoice(targetFile, item.introWav, item.introScript || '', voiceGainDb(kind, item.introPersona || undefined), {
        onQueued: q => this.onQueued(q, seg),
      });
      // Not deferred: introAired is already set and the queue state has to reach
      // disk whether or not the words are audible yet.
      this.persist();
      this.onSpoken(handoff, seg);
    } catch (err) {
      this.log('error', `Air intro failed: ${(err as Error).message}`);
    }
  }

  // Play a pre-rendered sound effect from the library UNDER the DJ voice.
  // Writes the effect's file path straight to sfx.txt — no TTS, the audio is
  // already rendered. Liquidsoap's sfx_queue mixes it beneath the voice
  // channels (see liquidsoap/radio.liq). Used by the segment-director agent
  // to garnish a spoken line, and by onTrackStarted for the between-track
  // stingers applyMixTransition arms at drain time.
  //
  // `underVoice` offsets the write by the voice lead-in (VOICE_LEADIN_MS) so a
  // stinger meant to sit under a spoken line lands with the DJ's first word
  // instead of during the channel's silent pre-roll. Transition stingers leave
  // it false — they have no voice to align to and must fire at the crossfade.
  async playSfx(name: string, { underVoice = false }: { underVoice?: boolean } = {}) {
    if (!name) return;
    try {
      const path = await sfx.getPath(name);
      if (!path) {
        this.log('error', `Unknown sound effect: ${name}`);
        return;
      }
      if (underVoice) await sleep(VOICE_LEADIN_MS);
      await writeHandoff(config.liquidsoap.sfxFile, path);
      this.log('sfx', name);
      session.appendTurn({ role: 'segment', kind: 'sfx', text: name });
    } catch (err) {
      this.log('error', `playSfx failed: ${(err as Error).message}`);
    }
  }

  // Air a jingle NOW — the on-demand counterpart to the rotate, for the station
  // ident or event announcement an operator fires by hand or from a dashboard
  // (POST /jingles/:filename/play, subwave_play_jingle). Manual trigger, so it
  // ignores jingleRatio: turning the rotate off silences the automatic draw,
  // never an explicit press.
  //
  // Deliberately NOT the sfx path, which is where this request first arrived:
  // an effect is amplified to 0.7 and mixed UNDER the programme with only a
  // light duck, so anything past a stinger's length drones on over the music —
  // which is exactly what SFX_MAX_SEC exists to prevent, and why raising that
  // cap would not have given anyone a usable announcement. A jingle instead
  // rides the music chain as its own item: full level, the programme yields to
  // it, and nothing bounds its length.
  //
  // It goes through its own handoff file and priority request.queue. That source
  // sits ahead of dj_queue, so an already-queued track cannot delay the press;
  // Liquidsoap keeps it unavailable while voice or a bed is active, preserving
  // the request until the next SAFE boundary rather than mixing over speech or
  // splitting a bed from the track it carries.
  //
  // Presses are DE-DUPLICATED, not rate-limited. jingle_now_queue is a FIFO with
  // no remove path (dj_queue has cancelQueued via dj_queue.remove; this has
  // nothing), and the fallback keeps selecting it while it is non-empty — so
  // every extra push is another announcement aired back-to-back with no music
  // between, and the only way out is /restart-mixer. An agent retrying a tool
  // call or a double-clicked dashboard button is enough to stack them. Pressing
  // the SAME jingle while it is still pending is that accident and is refused;
  // two DIFFERENT announcements queue normally, because an explicit operator
  // action always fires. PENDING_JINGLE_MAX bounds a runaway loop across files.
  async playJingle(filename: string) {
    if (!filename) throw new Error('Jingle filename is required');
    const path = await jingles.getPath(filename);
    if (!path) throw new Error(`Unknown jingle: ${filename}`);
    this.retirePendingJingles();
    if (this._pendingJingles.has(filename)) return { ok: false as const, reason: 'already-queued' as const };
    if (this._pendingJingles.size >= PENDING_JINGLE_MAX) return { ok: false as const, reason: 'queue-full' as const };
    await writeHandoff(config.liquidsoap.jingleFile, jingles.jingleUri(path), { maxWaitMs: 5000 });
    this._pendingJingles.set(filename, Date.now());
    // The sidecar's own script, not the hashed filename: every other segment
    // turn in the booth log and the DJ's chat history carries prose, and
    // `jingle_a1b2c3d4.wav` reads as noise next to them (playSfx logs its
    // effect NAME for the same reason).
    const label = (await jingles.list()).find(j => j.filename === filename)?.text || filename;
    this.log('jingle', `"${label}" queued — airs at the next safe boundary`);
    session.appendTurn({ role: 'segment', kind: 'jingle', text: label });
    return { ok: true as const };
  }

  // Retire presses that have been heard, or that are old enough that they never
  // will be. A mixer restart empties jingle_now_queue and loses the request
  // silently, so every entry has to expire on its own — the button must never
  // wedge shut on bookkeeping.
  retirePendingJingles() {
    const now = Date.now();
    for (const [name, at] of this._pendingJingles) {
      if (now - at > PENDING_JINGLE_TTL_MS || jingleAiredAtMs(name) >= at) {
        this._pendingJingles.delete(name);
      }
    }
  }

  // Called by the now-playing watcher when Liquidsoap reports a new track.
  onTrackStarted(np: NowPlaying | null) {
    if (!np || !np.title) return;
    const key = `${np.subsonic_id || ''}|${np.title}|${np.artist || ''}`;
    if (key === this.lastSeenKey) return;

    // Stem-blend safety guard: metadata matching a NOT-YET-SENT upcoming item
    // means a rendered clip annotated as that track is airing while the track
    // itself never reached Liquidsoap (a restart between the pair drain and the
    // clip, or a missed deadline). Consuming it as "played" would orphan it —
    // the clip ends, Liquidsoap falls to auto.m3u, and the track the clip just
    // introduced never airs. Force-drain NOW (bypassing the pair hold) and leave
    // this fire unprocessed: lastSeenKey stays unset, so the track's REAL fire
    // re-enters and the normal consume path takes over.
    if (np.subsonic_id && this.upcoming.some(u => !u.sent && u.track.id === np.subsonic_id)) {
      this.log('scheduler', `"${np.title}" fired while its queue item was still unsent — force-draining it (clip-as-track guard)`);
      void this.drainToLiquidsoap(true);
      return;
    }
    this.lastSeenKey = key;

    // A fresh track boundary — air any boundary-deferred segment (station
    // ident) now, unless this boundary already carries the incoming track's own
    // link/intro, in which case the ident holds for the next one (#1258). `np`
    // is passed so it can see that item while it's still in `upcoming` — the
    // consume+splice below happens after this, and the decision is made before
    // this call's first await. Fire-and-forget for the same reason as airIntro:
    // must not stall the watcher tick.
    void this.airPendingVoice(np);

    // Snapshot the outgoing track BEFORE the history roll mutates `this.current`
    // — scrobble.onTrackEvent below needs the previous play + its start time
    // to compute eligibility against Last.fm's >50% / >4min rule.
    const outgoingPrev = this.current
      ? { track: this.current.track, startedAt: this.current.startedAt }
      : null;

    // Roll previous current into history
    if (this.current) {
      const endedAt = new Date().toISOString();
      this.history.unshift({ ...this.current, endedAt });
      this.history = this.history.slice(0, 50);
      // Append to the rolling 24h sidecar used by the picker's recents window.
      // history is in-memory only and capped at 50 (~3h of plays) — too short
      // to catch the 2-3h repeat interval we've seen on the live station.
      const t = this.current.track;
      if (t) {
        this._recentPlays.unshift({
          id: t.id || null,
          title: t.title || null,
          artist: t.artist || null,
          endedAt,
        });
        this._recentPlays = this._recentPlays.slice(0, config.queue.recentPlaysMax);
        this.persistRecentPlays();
      }
    }

    // Match upcoming by subsonic_id first (reliable), fall back to title+artist
    // for older items that pre-date the id annotation. Same matcher
    // airPendingVoice used above, so the two always agree on the incoming item.
    const idx = this.matchUpcomingIndex(np);

    if (idx >= 0) {
      // Drop everything ahead of the match too: the queue is strictly FIFO, so
      // `idx > 0` means Liquidsoap already consumed those items — only possible
      // after a controller restart that missed their transitions. Splicing them
      // here keeps recovered zombies from lingering in "Up next" forever.
      const consumed = this.upcoming.splice(0, idx + 1);
      if (idx > 0) {
        this.log('scheduler',
          `Dropped ${idx} queue item(s) Liquidsoap played during the downtime`);
      }
      const item = consumed[consumed.length - 1];
      const source = item.aiPicked ? 'ai' : 'request';
      this.current = { ...item, startedAt: new Date().toISOString(), source };
      // A timed-out intro pre-render is keyed by the queued item. The current
      // item is a spread clone, so carry the lifecycle across that identity
      // hand-off before airIntro tries to reuse it.
      this._introRenders.transfer(item, this.current);
      this.log('playing', `${np.title} — ${np.artist}`, { requestedBy: item.requestedBy, source });
      // A tracked item matched → controller and Liquidsoap are in sync; clear any
      // dj_queue-empty desync streak accumulated from prior untracked plays.
      this._emptyDjQueueStreak = 0;
      // Transition stinger armed at drain (applyMixTransition) — fired HERE
      // because the crossfade this stinger was sized for is airing right now.
      // Re-gated on the live toggle: the operator may have switched SFX off
      // in the minutes between drain and air.
      if (item.transitionSfx && settings.get().sfx?.enabled) {
        void this.playSfx(item.transitionSfx);
      }
      // Air this track's intro/link now that it's actually on-air — deferred
      // from queue time so the voice lands over the right song (#189). Fire-
      // and-forget: airIntro's writeHandoff can block up to maxWaitMs and must
      // not stall the 1.5s watcher tick. Use the live `this.current` so the
      // introAired flag is set on the tracked object. Pass the track that just
      // rolled into history — the REAL predecessor — so a back-announcing link
      // that no longer follows the track it names (a request jumped the queue)
      // is dropped instead of airing a stale name.
      void this.airIntro(this.current, this.history[0]?.track || null);
    } else {
      // Not a tracked request → auto-playlist or jingle.
      // If we see untracked plays while there are sent items in `upcoming`,
      // those items might no longer be in Liquidsoap's dj_queue (e.g. after a restart).
      // Reconcile with the live dj_queue to clean up any stale entries.
      if (this.upcoming.some(i => i.sent)) {
        void this.reconcileWithDjQueue();
      }
      this.current = {
        track: {
          id: np.subsonic_id || null,
          title: np.title,
          artist: np.artist,
          album: np.album,
        },
        requestedBy: null,
        startedAt: new Date().toISOString(),
        source: 'auto',
      };
      this.log('playing', `${np.title} — ${np.artist}`, { source: 'auto' });
    }

    // Record the play into the live session's chat history.
    session.appendTurn({
      role: 'track', kind: 'play',
      text: `▶ "${this.current.track.title}" by ${this.current.track.artist || 'unknown'}`,
      meta: { source: this.current.source, requestedBy: this.current.requestedBy || null },
    });

    // The show on air right now — stamped onto the durable play record (and the
    // event log) so history can answer "what show was this on" without
    // correlating session archives after the fact.
    const onAirShow = session.getSession()?.show || null;

    // Milestone on the unified timeline — the anchor each pick trace hangs off.
    logEvent('track.play', {
      title: this.current.track.title,
      artist: this.current.track.artist || null,
      source: this.current.source,
      requestedBy: this.current.requestedBy || null,
      show: onAirShow?.name || null,
    });

    // Durable play history (library.db `plays`) — backs the admin Library
    // History tab. Fire-and-forget: a failed insert must never stall the
    // watcher tick, and the facade already swallows DB-not-open races.
    void library.recordPlay({
      trackId: this.current.track.id || null,
      title: this.current.track.title || null,
      artist: this.current.track.artist || null,
      album: this.current.track.album || null,
      playedAt: this.current.startedAt || new Date().toISOString(),
      source: this.current.source || null,
      requestedBy: this.current.requestedBy || null,
      showId: onAirShow?.id || null,
      showName: onAirShow?.name || null,
    });

    // `sourceTrackId` is the id from the music backend (Subsonic/Navidrome, or
    // whatever a router fronts), so a relay can resolve the exact library item
    // instead of fuzzy-matching artist+title (#1250). Same id `recordPlay` and
    // `scrobble` already take below. Null when the annotated URI carried no
    // `subsonic_id` — untracked auto-playlist plays, mainly — so consumers must
    // handle its absence. Deliberately NOT folded into `source`: that field
    // means how the track got queued (auto | ai | request) and existing relays
    // branch on it.
    const trackPayload = {
      title: this.current.track.title,
      artist: this.current.track.artist || null,
      album: this.current.track.album || null,
      sourceTrackId: this.current.track.id || null,
      source: this.current.source,
      requestedBy: this.current.requestedBy || null,
    };

    // Outbound fan-out — fire-and-forget; never blocks the picker path.
    // Optional listener gate (webhooksPolicy.trackPlayListenerGated): fail-closed
    // like scrobble — see scrobble.ts. Silent skip when gated and count unknown.
    const gated = !!settings.get()?.webhooksPolicy?.trackPlayListenerGated;
    if (gated) {
      const listeners = presentListeners();
      if (listeners !== null) {
        webhooks.notify('track.play', { ...trackPayload, listeners });
      }
    } else {
      webhooks.notify('track.play', trackPayload);
    }

    // Last.fm / ListenBrainz — also fire-and-forget. Internally gated on
    // listener count > 0 (fail-closed) and per-backend enable flags.
    scrobble.onTrackEvent({
      outgoing: outgoingPrev?.track
        ? {
            id: outgoingPrev.track.id || null,
            title: outgoingPrev.track.title || null,
            artist: outgoingPrev.track.artist || null,
            album: outgoingPrev.track.album || null,
            duration: outgoingPrev.track.duration ?? null,
          }
        : null,
      outgoingStartedAt: outgoingPrev?.startedAt || null,
      incoming: {
        id: this.current.track.id || null,
        title: this.current.track.title || null,
        artist: this.current.track.artist || null,
        album: this.current.track.album || null,
        duration: this.current.track.duration ?? null,
      },
    });

    this.persist();  // upcoming/current/history all just changed

    // Auto-DJ: when nothing is queued, hand a "track started" event to the
    // session DJ agent — it picks the next track and, on the link cadence,
    // writes a between-track link to air over what just started. Fire-and-
    // forget: the pick lands in Liquidsoap's dj_queue before this track ends.
    // Listener requests bring their own intro and don't count toward the gap.
    // When nobody is listening (and the pause toggle is on) skip the pick —
    // `upcoming` stays empty and Liquidsoap coasts on the auto playlist. The
    // watcher still gets onTrackStarted events for those auto tracks, so the
    // first transition after a listener returns re-enters this block.
    const isAutonomous = this.current.source === 'auto' || this.current.source === 'ai';
    if (this.autoPick && this.upcoming.length === 0 && !this.pickerBusy && djCallsAllowed()) {
      this.runPickCycle({ isAutonomous });
    }
  }

  // One full DJ pick cycle — session roll, programme plan, persona handoff,
  // link cadence, and the pick itself. Extracted from onTrackStarted so the
  // pair-drain deadline (maybeDeadlinePick) can fire the same cycle with the
  // pick's PREDECESSOR overridden to the held item it will follow —
  // queue.current at deadline time is one track too early for the event
  // text, the mini-run anchor, and the link's back-announce target.
  // Fire-and-forget like the original block; pickerBusy is the reentry guard.
  runPickCycle({ isAutonomous, predecessorItem = null }: { isAutonomous: boolean; predecessorItem?: QueueItem | null }) {
    let wantLink = false;
    if (this.autoLink && isAutonomous && this.history[0]) {
      this.tracksUntilLink--;
      if (this.tracksUntilLink <= 0) {
        this.tracksUntilLink = pickLinkInterval();
        wantLink = true;
      }
    }
    this.pickerBusy = true;
    (async () => {
      try {
        // The pick made now airs when the track it FOLLOWS ends, so near a show
        // boundary the rules to pick by are the NEXT show's. PICK_SHOW_LOOKAHEAD
        // probes a little past the expected start so a pick beginning just shy
        // of the boundary — and playing mostly inside the new show — counts as
        // the new show's.
        //
        // The lead is what REMAINS of the on-air track, never its full duration:
        // this cycle also runs from the deadline backstop and from boot
        // recovery, part-way through a track, where the elapsed part would push
        // `showAt` over the next boundary early (#1205). With a held predecessor
        // (deadline path) the pick follows the HELD track instead, so the lead
        // adds that track's length. Unknown clock → no look-ahead.
        //
        // This ONE date then drives the whole boundary sequence below — roll,
        // episode plan, mic-pass, episode hook — not just the pick. Leaving the
        // roll and handoff on the live clock is what let the two disagree: at
        // 09:58 the live grid still says "morning show", so the roll never fired
        // here and the :00 cron won it mid-song, airing the changeover track
        // (already picked under the incoming brief) BEFORE anyone handed over.
        // With one date there is no second date to disagree with.
        const leadSec = pickLeadSec(
          this.remainingSecOnAir(),
          predecessorItem ? knownDurationSec(predecessorItem.track) : null,
        );
        let showAt: Date | null = null;
        if (leadSec != null) {
          showAt = new Date(Date.now() + (leadSec + PICK_SHOW_LOOKAHEAD_SEC) * 1000);
        }
        const ctx = await getFullContext(showAt ?? undefined);
        await session.maybeRoll(ctx);
        // Plan a programme episode BEFORE the mic-pass so a handoff into a
        // programme show can weave the episode angle into its greeting.
        try {
          await programme.ensurePlan(ctx);
        } catch (err) {
          this.log('error', `Programme plan failed: ${(err as Error).message}`);
        }
        // If that roll crossed a persona boundary, air the mic-pass first
        // (sign-off + greeting) so it plays before the incoming DJ's first
        // pick. Guarded so a handoff failure never blocks the next track.
        // Drop a still-unaired ident first — airPendingVoice ran earlier in
        // this same tick, before the roll above existed to be seen.
        // (Under pair-drain the cycle fires near the on-air track's END, so
        // the mic-pass lands over its outro into the transition — a working
        // DJ's hand-off spot; deliberate, see stem-transitions research.)
        try {
          if (session.pendingHandoff()) {
            this.dropPendingVoice('the show handoff covers this boundary');
            // Identity looks ahead; the CLOCK must not. `ctx` describes
            // showAt — up to a track-length plus the look-ahead margin from
            // now — but the mic-pass airs immediately, so its prompt clock
            // would run minutes fast and the sign-off would misstate the time
            // on air (the failure #864 fixed for links). Take date/clock/time
            // from the live moment and keep show/mood/festival from the
            // look-ahead, which is the show being handed TO. Built only when a
            // handoff is actually pending, so this costs nothing per track.
            const live = await getFullContext();
            await djAgent.runPersonaHandoff(this, {
              ...ctx, at: live.at, date: live.date, clock: live.clock, time: live.time,
            });
          }
        } catch (err) {
          this.log('error', `Persona handoff failed: ${(err as Error).message}`);
        }
        // Programme shows: open the episode if the hourly cron hasn't
        // already (whichever call site settles the session first wins; the
        // beat flag makes the other a no-op).
        try {
          await programme.onSessionSettled(this, ctx);
        } catch (err) {
          this.log('error', `Programme episode hook failed: ${(err as Error).message}`);
        }
        await djAgent.runTrackEvent(this, ctx, {
          wantLink,
          showAt,
          predecessor: predecessorItem?.track ?? null,
          prior: predecessorItem ? (this.current?.track ?? null) : null,
        });
      } catch (err) {
        this.log('error', `DJ track event failed: ${(err as Error).message}`);
      } finally {
        this.pickerBusy = false;
      }
    })();
  }

  // Pair-drain deadline routine, run every watcher tick. When the on-air track
  // nears its end and the NEXT track is still held without a successor, fire the
  // pick cycle for that successor — the push() it ends in re-runs the drain
  // loop, which then sends the held item pair-aware.
  //
  // Fires ONLY for the item airing immediately after the on-air track (head of
  // `upcoming` unsent, and the only unsent item). Without that condition every
  // tick would pick another track and run the pipeline ahead unbounded; with it,
  // the fresh pick becomes the new held tail whose own deadline is a full track
  // away. Past the hard deadline the window closes and drainToLiquidsoap's
  // intrinsic path owns the endgame.
  maybeDeadlinePick() {
    if (!this.autoPick || this.pickerBusy || !djCallsAllowed()) return;
    if (!this.pairDrainActive()) return;
    const rem = this.remainingSecOnAir();
    if (!shouldDeadlinePick(rem)) return;
    // Attempt cooldown: the watcher tick re-enters every 1.5s for the whole
    // window, so a FAST-failing pick (LLM host down) would otherwise re-fire
    // dozens of times per window. A success stops matching the conditions
    // below on its own; this only meters failed attempts.
    if (Date.now() - this._deadlinePickAt < DEADLINE_PICK_COOLDOWN_SEC * 1000) return;
    if (this.upcoming.length === 0) {
      // Nothing queued at all this close to the end — the track-start pick
      // failed or never fired. Same backstop pick as onTrackStarted's.
      const isAutonomous = this.current?.source === 'auto' || this.current?.source === 'ai';
      this._deadlinePickAt = Date.now();
      this.runPickCycle({ isAutonomous });
      return;
    }
    const head = this.upcoming[0];
    const unsent = this.upcoming.filter(i => !i.sent);
    if (head.sent || unsent.length !== 1 || unsent[0] !== head) return;
    // The held head needs a successor: pick what follows it. Links only ride
    // autonomous seams — a request brings its own intro, mirroring the
    // track-start path's source check.
    this._deadlinePickAt = Date.now();
    this.runPickCycle({ isAutonomous: !head.requestedBy, predecessorItem: head });
  }

  // Did the pick we just pushed actually become a playable request? (#1405)
  //
  // A resolution failure — the origin answered with a Subsonic error body, the
  // file is gone, the fetch timed out — makes Liquidsoap drop the request
  // silently. Before this probe the controller found out only via
  // reconcileWithDjQueue, which needs three UNTRACKED track starts, i.e. ~3 auto
  // tracks of unfiltered radio for one bad URL. proto_subhttp now reports the
  // checked fetch outcome for this exact handoff; dj_queue membership is not
  // used because resolving requests can be visible OR popped for prefetch.
  // Never throws: this is a safety net over the drain, not part of it.
  async verifyPushResolved(item: QueueItem) {
    const probeId = item.resolveProbeId;
    if (!probeId) return;

    for (let read = 0; read < PUSH_PROBE_MAX_READS; read++) {
      await sleep(PUSH_PROBE_INTERVAL_MS);
      const outcome = await liquidsoapControl.subhttpProbeOutcome(probeId);

      const verdict = probeVerdict({
        // Aired (onTrackStarted spliced it), cancelled, or already reconciled
        // away — all mean this item is no longer ours to verify.
        stillQueuedLocally: !!item.sent && this.upcoming.includes(item),
        outcome,
      });
      if (verdict === 'pending') continue;
      if (verdict === 'abandon') return;
      if (verdict === 'resolved') {
        // Seen live in dj_queue: the push landed. Reuse the reconcile sweep's
        // own flag — it means exactly this — and let that sweep own the item
        // from here.
        item.confirmedInLiquidsoap = true;
        this._resolveFailStreak = 0;
        return;
      }
      this.onPushResolveFailed(item);
      return;
    }
  }

  // A push Liquidsoap never resolved: drop the dead item and re-pick now, so a
  // bad URL costs seconds of auto playlist instead of the ~3 tracks the
  // reconcile sweep needs to notice.
  onPushResolveFailed(item: QueueItem) {
    const idx = this.upcoming.indexOf(item);
    if (idx < 0) return;  // raced with a cancel/air between verdict and action
    this.upcoming.splice(idx, 1);
    this._resolveFailStreak++;
    this.persist();

    const who = item.requestedBy ? ` (requested by ${item.requestedBy})` : '';
    this.log('error',
      `Liquidsoap never resolved "${item.track?.title || 'unknown'} — ${item.track?.artist || 'unknown'}"${who}: it left dj_queue without airing. The music source returned an error instead of audio, or the file is missing/unreadable — check the broadcast log for a "protocol.subhttp" line and the music server's own log. Dropped from the queue.`);

    // A whole origin being down fails every re-pick the same way, and each one
    // costs an LLM call to queue a track that cannot air. Past the budget the
    // auto playlist keeps the station on air until the next natural pick.
    if (!repickAfterFailure(this._resolveFailStreak)) {
      this.log('scheduler',
        `${this._resolveFailStreak} unresolvable picks in a row — holding off on re-picks; the auto playlist covers the slot until the next track boundary`);
      return;
    }

    // Same gate as onTrackStarted's auto-DJ block: only re-pick when the slot is
    // genuinely empty, no pick is already running, and DJ calls are allowed.
    if (this.autoPick && this.upcoming.length === 0 && !this.pickerBusy && djCallsAllowed()) {
      this._deadlinePickAt = Date.now();  // this IS a pick attempt — stamp the backstop's cooldown
      const isAutonomous = this.current?.source === 'auto' || this.current?.source === 'ai';
      this.runPickCycle({ isAutonomous });
    }
  }

  // Reconcile Node's upcoming queue with Liquidsoap's actual dj_queue.
  // Drops items that were confirmed present in dj_queue at least once and are
  // now gone (played/consumed). Items never yet seen in dj_queue (the in-flight
  // grace period) are kept so a just-sent pick isn't dropped before Liquidsoap's
  // next poll (up to 1s after writeHandoff). An empty dj_queue is handled
  // separately — see the consecutive-empty-reads guard below.
  async reconcileWithDjQueue() {
    const sentItems = this.upcoming.filter(i => i.sent);
    if (sentItems.length === 0) {
      this._emptyDjQueueStreak = 0;
      return;
    }

    try {
      const liveIds = await liquidsoapControl.getDjQueueIds();

      // Empty dj_queue while we still hold sent items. A single read is
      // ambiguous: a pick may be mid-poll, Liquidsoap may have restarted and
      // lost the queue, or the last item is on air (popped) but its metadata
      // didn't match in onTrackStarted so it never left `upcoming`. So count
      // consecutive empties instead of dropping on one — after
      // EMPTY_DJ_QUEUE_CLEAR_THRESHOLD the sent items are genuinely gone or
      // stuck, and clearing them lets the auto-DJ (gated on
      // `upcoming.length === 0`) pick again. The counter advances only on an
      // authoritatively empty queue, so an interleaved jingle or an artist-string
      // mismatch resets it rather than tripping it.
      if (liveIds.size === 0) {
        this._emptyDjQueueStreak++;
        if (this._emptyDjQueueStreak >= EMPTY_DJ_QUEUE_CLEAR_THRESHOLD) {
          const cleared = sentItems.length;
          this.upcoming = this.upcoming.filter(i => !i.sent);
          this._emptyDjQueueStreak = 0;
          this.log('scheduler',
            `Cleared ${cleared} stale queue item(s) — dj_queue reported empty for ${EMPTY_DJ_QUEUE_CLEAR_THRESHOLD} consecutive checks (Liquidsoap restarted or queue desynced)`);
          this.persist();
        }
        return;
      }

      // Non-empty read → the queue is live; reset the desync streak.
      this._emptyDjQueueStreak = 0;

      // Pass 1: confirm items that ARE currently in dj_queue.
      for (const item of this.upcoming) {
        if (item.sent && item.track?.id && liveIds.has(item.track.id)) {
          item.confirmedInLiquidsoap = true;
        }
      }

      // Pass 2: drop only items that were confirmed-present and are now gone.
      const beforeCount = this.upcoming.length;
      this.upcoming = this.upcoming.filter(item => {
        if (!item.sent) return true;
        if (!item.confirmedInLiquidsoap) return true;  // grace period — keep
        const id = item.track?.id;
        if (!id) return true;  // no id to match against — keep
        return liveIds.has(id);
      });

      const droppedCount = beforeCount - this.upcoming.length;
      if (droppedCount > 0) {
        this.log('scheduler',
          `Reconciled with Liquidsoap dj_queue: dropped ${droppedCount} stale queue item(s) not present in Liquidsoap`);
        this.persist();
      }
    } catch (err) {
      this.log('error', `reconcileWithDjQueue failed: ${(err as Error).message}`);
    }
  }

  // Remove a not-yet-aired track from the upcoming queue (operator cancel).
  // Sent items live inside Liquidsoap's dj_queue, so those are pulled back
  // out over telnet first; the Node-side entry is only spliced once
  // Liquidsoap confirms, so a failed removal never half-cancels. A track
  // that already left dj_queue (on air, or being prepared as the next
  // source) refuses with 'already-playing' — /dj/skip is the tool for that.
  async removeUpcoming(trackId: string): Promise<{ ok: true } | { ok: false; reason: 'not-queued' | 'already-playing' }> {
    const item = this.upcoming.find(i => i.track?.id === trackId);
    if (!item) return { ok: false, reason: 'not-queued' };

    if (item.sent) {
      const { rid, bedRid } = await liquidsoapControl.resolveDjQueueRidWithBed(trackId);
      if (!rid || !(await liquidsoapControl.removeFromDjQueue(rid))) {
        return { ok: false, reason: 'already-playing' };
      }
      // The bed queued ahead of this track (item.bedded) is its own dj_queue
      // entry with no subsonic_id — the id-keyed removal above can't see it,
      // and left behind it airs as a voiceless instrumental. Best-effort: the
      // cancel itself already succeeded.
      if (item.bedded && bedRid) {
        const removed = await liquidsoapControl.removeFromDjQueue(bedRid).catch(() => false);
        if (removed) this.log('beds', `removed the bed queued ahead of cancelled "${item.track?.title}"`);
        else this.log('error', `orphan bed left in dj_queue after cancelling "${item.track?.title}"`);
      }
    }

    // Stem-blend cascade: a rendered clip queued for this track carries its
    // identity and would otherwise still air (the incoming half of a seam
    // whose track was just cancelled). Remove it too — best-effort: a clip
    // already being prepared can't be pulled, and the predecessor's early
    // cue_out then airs as an abrupt-but-crossfaded exit (accepted, logged).
    if (item.stemSeam && item.track?.id) {
      try {
        const clipRid = await liquidsoapControl.resolveClipRid(item.track.id);
        if (clipRid && await liquidsoapControl.removeFromDjQueue(clipRid)) {
          this.log('scheduler', `removed the rendered transition clip for ${item.track.title} along with it`);
        } else {
          this.log('scheduler', `transition clip for ${item.track.title} could not be removed — its predecessor will exit early into the clip`);
        }
      } catch { /* best-effort */ }
    }

    // …and the OUTGOING half (item.stemBlend): the clip queued right behind
    // this track was mixed from ITS tail and carries the successor's identity
    // — with the track cancelled it's an orphan that would air after whatever
    // actually plays (flipping now-playing to a track no seam justifies), and
    // the successor's stamped head-skip would then cut an intro no clip
    // fronts. Pull the clip and, while the successor is still unsent, clear
    // its seam stamps so it drains with its intrinsic head. A successor
    // already sent keeps them — its cue_in is annotated and gone, and the
    // clip still fronts it coherently; only the seam INTO the clip is abrupt
    // (accepted, as above). Same best-effort rules as the incoming half.
    if (item.stemBlend) {
      const next = this.upcoming[this.upcoming.indexOf(item) + 1];
      if (next?.stemSeam && next.track?.id) {
        if (!next.sent) {
          let clipRemoved = false;
          try {
            const clipRid = await liquidsoapControl.resolveClipRid(next.track.id);
            clipRemoved = !!clipRid && await liquidsoapControl.removeFromDjQueue(clipRid);
          } catch { /* best-effort */ }
          if (clipRemoved) {
            delete next.stemSeam;
            delete next.stemCueInSec;
            this.log('scheduler', `removed the rendered transition clip into ${next.track.title} along with it`);
          } else {
            // The clip stays queued, so the successor keeps its head-skip —
            // clip → track is still a coherent seam, only its entry is abrupt.
            this.log('scheduler', `transition clip into ${next.track.title} could not be removed — it will front the track after an abrupt seam`);
          }
        } else {
          this.log('scheduler', `cancelled the outgoing half of a rendered seam — the clip still fronts "${next.track.title}"`);
        }
      }
    }

    const idx = this.upcoming.indexOf(item);
    if (idx !== -1) this.upcoming.splice(idx, 1);
    this.log('scheduler', `operator removed from queue: ${item.track.title} — ${item.track.artist}`);
    this.persist();
    return { ok: true };
  }

  // Tracks played in the last `hours` hours — used by the picker to block
  // repeats. Returns BOTH ids and `title|artist` keys, because the boot
  // backfill (in recover()) reads from events-*.jsonl which lacks track ids;
  // a key-based fallback lets backfilled entries still block repeats. Walks
  // the rolling 24h sidecar (`_recentPlays`) newest-first to the cutoff and
  // also includes the current track so a mid-song pick can't re-pick it.
  recentlyPlayed(hours = 12) {
    const cutoff = Date.now() - hours * 3_600_000;
    const ids = new Set<string>();
    const keys = new Set<string>();
    const keyOf = (title: string | null | undefined, artist: string | null | undefined) =>
      `${(title || '').toLowerCase().trim()}|${(artist || '').toLowerCase().trim()}`;
    const cur = this.current?.track;
    if (cur?.id) ids.add(cur.id);
    if (cur?.title) keys.add(keyOf(cur.title, cur.artist));
    for (const p of this._recentPlays) {
      if (new Date(p.endedAt).getTime() < cutoff) break;
      if (p.id) ids.add(p.id);
      if (p.title) keys.add(keyOf(p.title, p.artist));
    }
    return { ids, keys };
  }

  // Backwards-compat shim — callsites that only need ids (e.g. legacy fallback
  // picker pool path that filters its own results) can keep calling this.
  recentlyPlayedIds(hours = 12): Set<string> {
    return this.recentlyPlayed(hours).ids;
  }

  // The last `n` DISTINCT tracks played — the count-based HARD no-repeat guard
  // (filterPickerCandidates hardRecent*, never relaxed). Clock-independent: it
  // walks the sidecar newest-first until it has seen `n` distinct tracks, so a
  // busy hour and a quiet one block the same number of songs.
  //
  // DISTINCT tracks, not raw rows: the sidecar can hold two entries for one play
  // (recordPlay logs it with an id at track-end, the boot backfill logs an
  // id-less copy at track-start), collapsed here via the shared title|artist
  // key, so `n` means n songs regardless of the double-write. Returns BOTH ids
  // and keys so a candidate is blocked by whichever identifier it carries, plus
  // the current track so a mid-song pick can't re-pick it.
  recentlyPlayedByCount(n = 0): { ids: Set<string>; keys: Set<string> } {
    const ids = new Set<string>();
    const keys = new Set<string>();
    if (!Number.isFinite(n) || n <= 0) return { ids, keys };
    const keyOf = (title: string | null | undefined, artist: string | null | undefined) =>
      `${(title || '').toLowerCase().trim()}|${(artist || '').toLowerCase().trim()}`;
    const cur = this.current?.track;
    if (cur?.id) ids.add(cur.id);
    if (cur?.title) keys.add(keyOf(cur.title, cur.artist));
    const seenIds = new Set<string>();
    const seenKeys = new Set<string>();
    let distinct = 0;
    for (const p of this._recentPlays) {
      if (distinct >= n) break;
      const k = keyOf(p.title, p.artist);
      // Already counted this track (by id OR by title|artist key)? Skip — this
      // is the duplicate sidecar row, not a second distinct play.
      if ((p.id && seenIds.has(p.id)) || (k && seenKeys.has(k))) continue;
      distinct++;
      if (p.id) {
        seenIds.add(p.id);
        ids.add(p.id);
      }
      if (k) {
        seenKeys.add(k);
        keys.add(k);
      }
    }
    return { ids, keys };
  }

  queuedIds(): Set<string> {
    const ids = new Set<string>();
    if (this.current?.track?.id) ids.add(this.current.track.id);
    for (const item of this.upcoming) {
      if (item.track?.id) ids.add(item.track.id);
    }
    return ids;
  }

  // Honest acknowledgement for a listener request whose resolved track is
  // already queued or on air — used when push() dedups the request (issue
  // #619). Lets the caller send a truthful line instead of a false "coming up"
  // or a phantom second back-to-back play. Distinguishes the on-air case so the
  // listener isn't told something is "on the way" when it's playing right now.
  dedupAck(trackId: string | null | undefined): string {
    const onAir = !!trackId && this.current?.track?.id === trackId;
    return onAir
      ? `That one's spinning right now — stay tuned.`
      : `That track's already queued — it's on the way.`;
  }

  // Honest acknowledgement for a request refused by the repeat cooldown (B6).
  // Same on-air split as dedupAck, and for the same reason: recentlyPlayedIds
  // includes the track CURRENTLY playing, so the plain "just spun" line told a
  // listener their song was over while they could still hear it.
  cooldownAck(trackId: string | null | undefined, title: string): string {
    const onAir = !!trackId && this.current?.track?.id === trackId;
    return onAir
      ? `That one's spinning right now — give it a bit before you ask again.`
      : `"${title}" just spun — give it a rest for a bit.`;
  }

  // The LEAD-artist keys (artistRootKey — collaborations collapse onto the
  // artist fronting them) of the slots AROUND the next pick: everything queued
  // and still unaired, the track on air, and the last `n` DISTINCT tracks
  // played. Count-based and clock-independent, exactly like
  // recentlyPlayedByCount above and for the same reason: this answers "who has
  // been in the last few slots", which is a question about slots, not hours.
  //
  // The queued side matters because a pick is not always adjacent to the track
  // on air — with pair-aware drains (and with any request stacked ahead) it
  // lands behind one or more queued tracks, which have no play row yet. It
  // takes the TAIL of the queue: a pick appends to the end, so its nearest
  // neighbours are the last `n` queued, not the first.
  //
  // Sole consumer is the agent path's back-to-back artist guard (#1251), whose
  // re-pick steps around these artists — hence root keys rather than the raw
  // keys recentArtistsSince returns; that one feeds the pool picker's relaxable
  // recentArtists filter, which matches raw against raw. Empty set when n <= 0.
  neighbourArtistRoots(n = 0): Set<string> {
    const out = new Set<string>();
    if (!Number.isFinite(n) || n <= 0) return out;
    const add = (artist: string | null | undefined) => {
      const key = artistRootKey({ artist });
      if (key) out.add(key);
    };
    for (const item of this.upcoming.slice(-n)) add(item?.track?.artist);
    add(this.current?.track?.artist);
    // Distinct TRACKS, not rows — the sidecar can hold two entries for one play
    // (see recentlyPlayedByCount), and a duplicate row must not burn a slot.
    const seenIds = new Set<string>();
    const seenKeys = new Set<string>();
    let distinct = 0;
    for (const p of this._recentPlays) {
      if (distinct >= n) break;
      const k = trackKey(p);
      if ((p.id && seenIds.has(p.id)) || (k && seenKeys.has(k))) continue;
      distinct++;
      if (p.id) seenIds.add(p.id);
      if (k) seenKeys.add(k);
      add(p.artist);
    }
    return out;
  }

  // Lowercased artist names heard in the last `hours` hours — used by the
  // picker to block recently-heard artists. 2h is a sane default; raising it
  // narrows the pool fast on a small library.
  recentArtistsSince(hours = 2) {
    const cutoff = Date.now() - hours * 3_600_000;
    const out = new Set<string>();
    if (this.current?.track?.artist) {
      out.add(this.current.track.artist.toLowerCase().trim());
    }
    for (const p of this._recentPlays) {
      if (new Date(p.endedAt).getTime() < cutoff) break;
      const k = (p.artist || '').toLowerCase().trim();
      if (k) out.add(k);
    }
    return out;
  }

  // A bed started feeding the music chain — air the link it was pushed for.
  //
  // Unlike waitForJingleClear (which computes a deadline and sleeps it out),
  // this has to be an event: the bed is pushed minutes before it airs and the
  // link must land ON it. radio.liq writes bed-playing.json the moment the bed's
  // metadata fires, so a new startedAt is the edge — deduped on that value, like
  // onTrackStarted's track key, since the file is never deleted and a stale
  // marker must not re-fire.
  //
  // Song B's own onTrackStarted also calls airIntro for this item a bed later;
  // airIntro sets introAired before any await, so that is already idempotent.
  onBedStarted() {
    // The bed is pushed immediately ahead of its item, so the item a marker
    // belongs to is the first bedded one still waiting to speak. No such item
    // (the overwhelmingly common tick) → nothing to do, skip the disk read.
    const item = this.upcoming.find(i => i.bedded && i.sent && !i.introAired);
    if (!item) return;

    let startedAt = 0;
    try {
      const m = JSON.parse(readFileSync(config.liquidsoap.bedPlayingFile, 'utf8'));
      startedAt = Number(m?.startedAt) || 0;
    } catch {
      return; // no marker — nothing has ever bedded
    }
    if (!startedAt || startedAt === this._lastBedStartedAt) return;
    this._lastBedStartedAt = startedAt;

    // _lastBedStartedAt doesn't survive a restart but the marker file (and the
    // recovered bedded item) does — an old startedAt seen on the first ticks
    // of a new process is the PREVIOUS bed, not this item's, and firing on it
    // would air the link over whatever is playing now. Only a marker fresh
    // enough to have been written since the last tick is an edge.
    const startedMs = startedAt * 1000; // liquidsoap time() is unix seconds
    if (Date.now() - startedMs > BED_MARKER_FRESH_MS) return;

    // The marker fires at cross-FEED time — the predecessor's whole exit
    // canvas plays out before the bed is dominant, and the bed was sized to
    // carry it (item.bedEntrySec). Hold the link for what remains, so the
    // DJ's first words land on the solo bed, not the outgoing song's fade.
    const waitMs = Math.max(0, startedMs + (item.bedEntrySec || 0) * 1000 - Date.now());
    this.log('beds', `bed on air → airing the link for "${item.track?.title}"${
      waitMs > 0 ? ` in ${(waitMs / 1000).toFixed(1)}s (entry cross)` : ''}`);
    // overBed: the marker above IS the bed feeding the music chain, so this is
    // the one call site that can state it as a fact rather than infer it from
    // item.bedded (see airIntro).
    const fire = () => void this.airIntro(item, this.current?.track || null, { overBed: true });
    if (waitMs > 0) setTimeout(fire, waitMs);
    else fire();
  }

  // Poll now-playing.json every 1.5s and dispatch track changes. Each tick
  // also refreshes the in-memory copy getNowPlaying() serves, so the
  // per-listener /now-playing poll never has to touch the disk.
  startWatcher() {
    const tick = async () => {
      this._nowPlaying = await this.readNowPlayingFromDisk();
      this._nowPlayingFresh = true;
      this.onTrackStarted(this._nowPlaying);
      // Beds ride the same tick rather than a poller of their own — a bed's
      // start is a track-boundary event like any other, and the 1.5s cadence is
      // already inside the head budget bed-policy sizes the bed with.
      this.onBedStarted();
      // Pair-aware transitions: the deadline pick + a drain re-run every
      // tick. Drain holds are time-gated, and push() only fires the drain on
      // mutation — the clock advancing past a deadline has to re-trigger it
      // from here (cheap: senderBusy + an immediate hold-break otherwise).
      this.maybeDeadlinePick();
      void this.drainToLiquidsoap();
    };
    void tick();
    setInterval(tick, 1500);
    this.log('scheduler', 'Now-playing watcher started');
  }

  snapshot() {
    const mapItem = (i: QueueItem) => ({
      // Track id rides along so the admin dash can target rows for the
      // queue-cancel button (DELETE /dj/queue/:trackId); named to match the
      // subsonic_id already public on /now-playing.
      subsonic_id: i.track.id,
      title: i.track.title,
      artist: i.track.artist,
      album: i.track.album,
      requestedBy: i.requestedBy,
      source: i.source,
      startedAt: i.startedAt,
      endedAt: i.endedAt,
      queuedAt: i.queuedAt,
      sent: i.sent,
      // The track arrives via a pre-rendered stem blend rather than a plain
      // crossfade (#1257 — the admin queue badges the seam type). Stamped at
      // pair drain, cleared if the clip is pulled with a cancel, so it's
      // definitive, not a prediction; absent = plain crossfade.
      stemSeam: i.stemSeam || undefined,
    });
    return {
      current: this.current ? mapItem(this.current) : null,
      upcoming: this.upcoming.map(mapItem),
      history: this.history.map(mapItem),
      // One operator-facing answer for the imminent FINALISED seam. Effect
      // flags live on opposite sides of the pair and remain proposals until
      // the incoming item drains, so derive + gate this here rather than
      // making the dashboard reverse-engineer mixer precedence/lifecycle.
      nextTransition: nextTransitionLabel(this.current, this.upcoming[0]),
      djLog: this.djLog.slice(0, 50),
      autoPick: this.autoPick,
      autoLink: this.autoLink,
      pickerBusy: this.pickerBusy,
    };
  }

  // Now-playing as Liquidsoap last reported it. Served from the watcher's
  // in-memory copy: every listener polls /now-playing every ~5s and the
  // watcher already re-reads the file every 1.5s, so a per-request disk
  // read + parse buys nothing. Falls back to a direct read until the first
  // watcher tick lands (or when the watcher was never started, e.g. one-off
  // scripts). Returns a copy — callers (routes/public.ts) enrich the object
  // in place and must not leak those fields into the shared cache.
  async getNowPlaying() {
    const np = this._nowPlayingFresh
      ? this._nowPlaying
      : await this.readNowPlayingFromDisk();
    return np ? { ...np } : null;
  }

  // Read the now-playing JSON Liquidsoap writes
  async readNowPlayingFromDisk() {
    try {
      const raw = await readFile(config.liquidsoap.nowPlayingFile, 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}

// The queue instance's public surface — the type modules that receive the
// singleton (broadcast/programme.ts, dj-agent.ts) annotate their `queue` param
// against. A type-only export, so importers pull it without a runtime cycle.
export type QueueApi = InstanceType<typeof Queue>;

export const queue = new Queue();
