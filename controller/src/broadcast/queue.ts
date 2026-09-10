// Queue manager: the in-memory queue, the single writer of next.txt, and the
// now-playing watcher that rotates upcoming → current → history. The non-class
// pieces live in ./queue/ and are re-exported below.

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
import { swallowedByCrossfade } from '../util/request-guard.js';
import * as showBoundary from './show-boundary.js';
import * as blocklist from '../music/blocklist.js';
import { artistRootKey, trackKey, type CandidateLike } from '../music/recency.js';
import { albumKeyFor } from '../music/album-facts.js';
import { speak, voiceGainDb } from '../audio/tts.js';
import * as djAgent from './dj-agent.js';
import * as programme from './programme.js';
import * as sfx from './sfx.js';
import * as jingles from './jingles.js';
import { pickRotateJingle, onJingleRotateOwnerChange } from './jingle-rotate.js';
import * as beds from './beds.js';
import * as bedPolicy from './bed-policy.js';
import { vocalRunwayMs, segmentFitsRunway } from './vocal-runway.js';
import * as session from './session.js';
import type { TurnMeta } from './session.js';
import type { PromptMemoryEntry } from './prompt-memory.js';
import { getFullContext, getClockContext, energyForDaypart } from '../context.js';
import * as settings from '../settings.js';
import { TRANSITION_EFFECTS } from '../settings/vocab.js';
import { logEvent } from '../observability/events.js';
import { djCallsAllowed, presentListeners } from './listeners.js';
import { autoVoiceAllowed } from './voice-policy.js';
import { holdsForClosingTrack } from './handover-policy.js';
import { speakClockAllowed, stationIdDaypartDrifted, stationIdDaypartStamp } from './clock-policy.js';
import { currentTalkAir } from './talk-air.js';
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
  TRACK_TIED_KINDS,
  VOICE_KINDS,
  pendingVoiceStale,
} from './queue/kinds.js';
import type { PendingTalk } from './queue/kinds.js';
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

// One spoken segment, read twice: at commit (onQueued) and at air (onSpoken).
interface SegmentDesc {
  kind: string;
  /** Handoff file the clip went out on. Set by the caller, never re-derived
   *  from `kind` — a boundary-deferred ident is say-kind on the intro channel. */
  channel: 'say' | 'intro';
  text: string;
  meta?: TurnMeta;
  persona?: Persona | null;
  /** Booth-log line when it differs from the spoken text (banter prefixes the speaker). */
  logText?: string | null;
  /** Whether this segment also fires the legacy dj.say/dj.link event. */
  legacy?: boolean;
}

// The one boundary-deferred segment slot behind announceAtNextTrack() and
// airPendingVoice(). `clips` is a list because a banter exchange is several
// lines aired back to back; it is still ONE segment and the queue never holds
// two (talk-scheduler's pendingHolds enforces that).
interface PendingVoice {
  kind: string;
  clips: { text: string; wavPath: string; persona: Persona | null; meta: TurnMeta }[];
  /** Daypart the model was allowed to claim, or null. stationIdDaypartDrifted
   *  refuses a stale clip on this stamp. */
  daypart: string | null;
  /** Whether the clips are lines of one multi-voice exchange, which decides the
   *  attribution they air under and the single webhook they owe. */
  exchange: boolean;
  /** Enqueue time — anchor for both the stale drop and the planner's hold. */
  t: number;
}

// Re-exported so every existing `from './queue.js'` import keeps working.
export { BACKFILL_DEDUP_MAX_GAP_MS, boundaryCarriesTrackVoice, playAlreadyRecorded, shouldDropStaleLink } from './queue/pure.js';
export { registerSkillKinds } from './queue/kinds.js';
export type { NowPlaying, QueueItem, Track } from './queue/types.js';

// One notion of "a real cue offset" for every cue arbitration in the drain
// (earliest wins for cue_out, latest for cue_in), so the cap, the trim and a
// rendered blend cannot disagree about the tail they all cut.
function positiveCues(values: (number | null | undefined)[]): number[] {
  return values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
}

// Bound on a runaway loop of manual jingle presses across different filenames.
const PENDING_JINGLE_MAX = 3;
// The automatic rotate's own budget, counted SEPARATELY (#1619). The two must
// not share, because the shared form is how the operator's button gets wedged
// shut by something the operator did not do: a mixer restart empties
// jingle_now_queue with no signal, so three rotates inside the TTL below would
// hold every slot and the next press would answer `queue-full` — the exact
// failure PENDING_JINGLE_TTL_MS exists to prevent, reintroduced from the other
// side. Reserving a slot instead would still shrink the operator's headroom
// from 3 to 2 for a caller that is not a runaway risk at all.
//
// ONE, not three, and that is the honest number rather than a smaller share of
// the same budget: the rotate is one-at-a-time by construction — the counter is
// zeroed at handoff, so it cannot come due again until N more boundaries have
// passed — which means a SECOND pending rotate can only mean the first never
// aired. Queuing another on top of it is precisely the stinger-stacking the
// FIFO has no remove path to undo. A rotate refused here spends its offer and
// skips, which is the cheaper miss radio.liq's own `source.available` gate took.
const PENDING_ROTATE_JINGLE_MAX = 1;
// How long a press stays pending before it is assumed lost. A mixer restart
// empties jingle_now_queue and drops the request with no signal, so this is what
// stops that from wedging the button shut. Generously past any single track, so
// it never retires a press that is merely waiting for its boundary.
const PENDING_JINGLE_TTL_MS = 30 * 60 * 1000;

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
  _pendingVoice: PendingVoice | null = null; // one boundary-deferred segment awaiting the next track start — see announceAtNextTrack
  _trackStarts = 0;             // monotonic count of track boundaries seen — the clock the handover ordering rule is measured on
  _handover: { atTrackStarts: number; heldOpportunities: number; rolledOnce: boolean } | null = null; // stamped when a sign-off airs, read by closingTrackHolds() — see broadcast/handover-policy.ts
  _lastSessionId: string | null = null;  // last session id onSessionRolled saw — the clock the handover wait is aged on
  _introRenders = new IntroRenderTracker<QueueItem>(); // timed-out pre-renders stay reusable by airIntro
  // Jingle handoffs made but not yet heard — see playJingle. ONE map for both
  // callers on purpose: the de-duplication question ("is this clip already
  // waiting?") has to be answered across the operator's presses and the
  // automatic rotate together, so a second map would be a second source of
  // truth for it. Only the CAP is per-caller, which is what `rotate` records.
  _pendingJingles = new Map<string, { at: number; rotate: boolean }>();
  _tracksSinceJingle = 0;       // track boundaries since the last controller-drawn jingle — the count radio.liq's rotate used to keep (#1619)
  _lastRotateJingle: string | null = null; // last jingle the controller drew — anti-repeat for jingle-rotate.pickRotateJingle

  // Snapshot to disk so a controller restart doesn't turn tracks already in
  // dj_queue into untracked `auto` plays. Debounced.
  persist() {
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(async () => {
      this._persistTimer = null;
      try {
        await writeFileAtomic(config.queue.file, JSON.stringify({
          upcoming: this.upcoming,
          current: this.current,
          history: this.history,
          // The rotate's boundary count (#1619). Snapshotted for the same
          // reason the queue itself is — a controller restart is routine, every
          // `--build controller` is one — and unlike `_trackStarts`, which is
          // only ever read as a DIFFERENCE against a stamp taken in the same
          // process, this one is absolute: losing it costs up to a full
          // `jingleRatio` of tracks before the next stinger, which at the
          // default 30 is roughly two hours of silence from the rotate after
          // every upgrade.
          tracksSinceJingle: this._tracksSinceJingle,
          lastRotateJingle: this._lastRotateJingle,
          savedAt: new Date().toISOString(),
        }, null, 2));
      } catch (err) {
        console.error('[queue] persist failed:', (err as Error).message);
      }
    }, 500);
  }

  // Rolling recent-plays sidecar. Separate timer from persist() so neither
  // write blocks on the other.
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

  // Boot recovery: reload the persisted queue so items already sent to
  // Liquidsoap stay tracked. `lastSeenKey` is primed from the restored
  // `current` so the watcher doesn't re-fire for the track still on air.
  recover() {
    if (!existsSync(config.queue.file)) return;
    try {
      const stored = JSON.parse(readFileSync(config.queue.file, 'utf8'));
      // Drop anything old enough that Liquidsoap has certainly played past it,
      // so a stale snapshot can't resurrect permanent "Up next" zombies.
      const cutoff = Date.now() - 2 * 60 * 60 * 1000;
      this.upcoming = (Array.isArray(stored.upcoming) ? stored.upcoming : [])
        .filter((i: QueueItem) => i?.track?.title && new Date(i.queuedAt || 0).getTime() > cutoff);
      this.current = stored.current || null;
      this.history = Array.isArray(stored.history) ? stored.history : [];
      // Restore the rotate's count (#1619). Repaired, not trusted: this file is
      // on the operator's disk, and a junk value here decides how long the
      // station goes without a stinger. A snapshot written before this field
      // existed reads as 0, which is the pre-#1619 behaviour.
      const since = Number(stored.tracksSinceJingle);
      this._tracksSinceJingle = Number.isFinite(since) && since >= 0 ? Math.floor(since) : 0;
      this._lastRotateJingle = typeof stored.lastRotateJingle === 'string' ? stored.lastRotateJingle : null;
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
          // 96h is enough to supply a maxed count-based no-repeat window
          // (up to 1000 distinct ≈ 2-3 days of air) without the file ballooning.
          const cutoff = Date.now() - 96 * 3_600_000;
          this._recentPlays = arr
            .filter((p: RecentPlay) => p && p.endedAt && new Date(p.endedAt).getTime() > cutoff)
            .slice(0, config.queue.recentPlaysMax);
        }
      } catch (err) {
        console.error('[queue] recent-plays recover failed:', (err as Error).message);
      }
    }
    // The sidecar is often shallower than the 12h no-repeat window; the events
    // log is durable and has every track.play, so backfill from it.
    this.backfillRecentPlaysFromEvents();
    this.log('scheduler',
      `Recent-plays loaded: ${this._recentPlays.length} entries (last 24h)`);
  }

  // Merge the last 24h of track.play events into _recentPlays. Events carry no
  // track id, so backfilled entries block repeats via the title|artist key path.
  backfillRecentPlaysFromEvents() {
    try {
      const cutoff = Date.now() - 24 * 3_600_000;
      // Dedup on title|artist within a track-length window (playAlreadyRecorded),
      // never an exact-timestamp key: the sidecar stores end stamps, events start ones.
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
            // Check both the sidecar and this pass, so two events for one play
            // can't both slip through.
            if (playAlreadyRecorded(this._recentPlays, e, BACKFILL_DEDUP_MAX_GAP_MS)) continue;
            if (playAlreadyRecorded(filled, e, BACKFILL_DEDUP_MAX_GAP_MS)) continue;
            filled.push({
              id: null,
              title: e.title || null,
              artist: e.artist || null,
              album: e.album || null,
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

  // Recap of recent aired utterances for prompt injection, or null. `prior`
  // reads the session a hard roll just archived; the mic-pass sign-off is its
  // only caller.
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

  // First ~5 words of recent utterances, for the prompt's "don't open with any
  // of these" list.
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

  // Text of the most recent between-track link that AIRED, or null. djLog voice
  // entries are written by onSpoken, so a composed-then-dropped link never lands
  // here — which is what makes this the right anchor for announce-mode
  // alternation (broadcast/announce-line.ts).
  getLastLinkText(): string | null {
    for (const entry of this.djLog) {
      if (entry.kind === 'link') return entry.message || null;
    }
    return null;
  }

  // Timestamp (ms) of the most recent aired spoken segment, or 0. Defaults to
  // every voice kind; `kinds` narrows it (the segment director's frequency floor
  // asks only about wall-clock talkers, since track-tied links would mute it
  // outright on a chatty station).
  getLastVoiceAt(kinds?: readonly string[]) {
    const match = kinds ? new Set(kinds) : VOICE_KINDS;
    for (const entry of this.djLog) {
      if (match.has(entry.kind)) return new Date(entry.t).getTime();
    }
    return 0;
  }

  // Timestamp (ms) of the most recent STANDALONE talk break, or 0: every voice
  // kind except the track-tied intro channels, which air with nearly every pick.
  getLastTalkBreakAt() {
    for (const entry of this.djLog) {
      if (TRACK_TIED_KINDS.has(entry.kind)) continue;
      if (VOICE_KINDS.has(entry.kind)) return new Date(entry.t).getTime();
    }
    return 0;
  }

  // Show-handover ordering state (#1576); the rule is in handover-policy.ts.
  //
  // Post-air hook: a programme outro reached the stream, so the incoming host
  // owes the listener a closing track first. Keyed on what AIRED, not on the
  // beat having fired — an operator pressing the outro pad signs the show off
  // too, and a beat that never aired has not. Re-stamping restarts the wait;
  // the incoming host's own first words clear it.
  noteHandoverSpeech(kind: string) {
    if (kind === 'programme-outro') {
      this._handover = { atTrackStarts: this._trackStarts, heldOpportunities: 0, rolledOnce: false };
      return;
    }
    if (kind === 'handoff' || kind === 'programme-intro') this._handover = null;
  }

  // Age the wait across session rolls. The sign-off airs BEFORE the roll it
  // belongs to, so the FIRST roll is the changeover the wait is owed to and must
  // not clear it; a SECOND roll means the incoming host never opened and the
  // debt is owed to nobody. Counted in changeovers, not on a clock.
  onSessionRolled(sessionId: string | null) {
    if (sessionId === this._lastSessionId) return;   // maybeRoll was a no-op
    this._lastSessionId = sessionId;
    const h = this._handover;
    if (!h) return;
    if (h.rolledOnce) this._handover = null;
    else h.rolledOnce = true;
  }

  // Whether the incoming host must wait for the closing track. Pure: asking
  // costs nothing, so the wall-clock session roll can ask without spending the wait.
  closingTrackHolds(): boolean {
    const h = this._handover;
    if (!h) return false;
    return holdsForClosingTrack({
      boundariesSince: this._trackStarts - h.atTrackStarts,
      heldOpportunities: h.heldOpportunities,
    });
  }

  // Bank a declined handover opportunity. ONLY a drain/boundary cycle that could
  // itself have aired the greeting may call this: the wall-clock :00 roll asks
  // minutes before any music has moved, and banking its answer would spend the
  // opportunity inside the sign-off's own track.
  noteHandoverOpportunityDeclined() {
    const h = this._handover;
    if (h) h.heldOpportunities++;
  }

  // The live wait, for /debug. `null` means no sign-off is outstanding.
  handoverWait() {
    const h = this._handover;
    if (!h) return null;
    return {
      boundariesSince: this._trackStarts - h.atTrackStarts,
      heldOpportunities: h.heldOpportunities,
      holding: this.closingTrackHolds(),
    };
  }

  // Add a track to `upcoming` and kick off the Liquidsoap sender.
  //
  // `introScript` is rendered to a WAV by the drain and aired by airIntro() only
  // when the track starts. `introKind` picks engine routing and the DEFAULT duck
  // channel ('dj-speak' → say.txt heavy, 'link' → intro.txt light); a clip on a
  // bed takes the light duck whatever its kind (airIntro's `overBed`).
  //
  // `linkPrev` is the track the intro back-announces; airIntro drops the
  // back-announce if something slipped in ahead. Null for request intros.
  //
  // `linkClockAt` is the air moment the script was written against, set only
  // when the generator gave the model a clock to speak (#1314). airIntro drops
  // the line if the real seam lands too far from it — the forecast is made from
  // the on-air track's remaining play and goes badly wrong when the pick misses
  // that seam and auto.m3u fills the slot.
  async push({ track, requestedBy = null, operator = false, block = null, intent = null, introScript = null, introKind = 'dj-speak', introPersona = null, aiPicked = false, allowDuplicate = false, linkPrev = null, linkClockAt = null }: {
    track: Track;
    requestedBy?: string | null;
    operator?: boolean;
    block?: QueueItem['block'] | null;
    intent?: string | null;
    introScript?: string | null;
    introKind?: string;
    introPersona?: Persona | null;
    aiPicked?: boolean;
    allowDuplicate?: boolean;
    linkPrev?: { id?: string | null; title?: string | null; artist?: string | null } | null;
    linkClockAt?: Date | number | null;
  }) {
    // The blocklist is absolute, so it sits above `allowDuplicate`. Every
    // playback path funnels through push(), making this the last line even for
    // sources that bypass the subsonic/library filters.
    const blockHit = blocklist.hitOf(track);
    if (blockHit) {
      // Name what refused it, so a rule (especially a seasonal one) is findable
      // on the Blocked tab rather than reading as "not found".
      const why = blockHit.kind === 'rule'
        ? `blocked by rule "${blockHit.label}"${blockHit.seasonal ? ' (out of season)' : ''}, refused`
        : 'on the never-play blocklist, refused';
      this.log('blocked', `${track?.title} — ${track?.artist} (${why})`);
      return -2;
    }
    // The only synchronous point where two concurrent resolutions of the same
    // song are both visible (#619) — no await between here and upcoming.push()
    // below, so it closes the race. `allowDuplicate` opts an operator action out.
    if (!allowDuplicate && track?.id) {
      const dominated = this.upcoming.some(i => i.track?.id === track.id)
        || (this.current?.track?.id === track.id);
      if (dominated) {
        this.log('dedup-skip', `${track.title} -- ${track.artist} (already queued)`);
        return -1;
      }
    }
    const item = {
      track, requestedBy, operator, intent, introScript, introKind, introPersona, aiPicked,
      block: block ?? undefined,
      // Only stamp a back-announce target when there's actually an intro/link to
      // air against it; a bare track carries no claim about what preceded it.
      linkPrev: (introScript && linkPrev)
        ? { id: linkPrev.id ?? null, title: linkPrev.title ?? null, artist: linkPrev.artist ?? null }
        : null,
      // Same gate as linkPrev: only a line that exists carries an air moment.
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
    // A block's members are deliberately SILENT here and the route logs one
    // summary line instead (#1622 FR 4). The booth log is a 200-entry ring the
    // operator reads back through, and thirty consecutive "queued" lines off a
    // single press would evict most of the history that press was made against
    // — while saying nothing the one block line does not say better.
    if (!block) {
      this.log('queued', `${track.title} — ${track.artist}`, { requestedBy, queueDepth: this.upcoming.length });
    }
    this.warnIfSwallowedByCrossfade(item);
    this.persist();
    this.drainToLiquidsoap();  // fire-and-forget
    return this.upcoming.length;
  }

  // A request whose whole playable span is under the crossfade is buffered into
  // the transition and never sounds — it leaves dj_queue with no error anywhere
  // (#1594). Log only: nothing is declined, nothing is dropped.
  //
  // Gated on `requestedBy` because a request is the one path exempt from every
  // length rule, so the only path where a sub-crossfade track is expected. The
  // span is the PLAYABLE one via music/silence-trim.ts, never a local subtraction.
  //
  // `crossfadeDuration` is the CONFIGURED figure; the mixer reads it once at
  // startup, so the line itself says a restart is pending.
  //
  // The whole body is in try/catch on purpose: playableSpanSec is the first
  // sqlite read on the request critical path, and an informational log line may
  // not turn a listener request into a 500.
  warnIfSwallowedByCrossfade(item: QueueItem) {
    try {
      if (!item.requestedBy) return;
      const crossSec = Number(settings.get()?.crossfadeDuration);
      const spanSec = silenceTrim.playableSpanSec(item.track);
      if (spanSec == null || !swallowedByCrossfade(spanSec, crossSec)) return;
      this.log('crossfade',
        `"${item.track?.title} — ${item.track?.artist}" (requested by ${item.requestedBy}) has only ${Math.round(spanSec)}s of playable audio, under the ${crossSec}s crossfade — Liquidsoap buffers the whole track into the transition, so it will leave the queue without ever being heard. Nothing declined it: requests are exempt from the length rules on purpose. To air clips this short, lower the crossfade and restart the mixer — the mixer reads that setting once at startup, so until it does it is still buffering the old value.`,
        { requestedBy: item.requestedBy, trackId: item.track?.id ?? null, spanSec, crossSec });
    } catch { /* informational only — never let it decide the request's fate */ }
  }

  // Drop now-blocked tracks from `upcoming` after a blocklist edit. Only
  // undrained items are removable; anything already handed over plays out.
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
    // Measured ending: feeds the ending-aware exit canvas + chop-over-fade veto.
    const outro = track.outro ?? rec?.outro ?? null;
    const ending = outro?.ending === 'fade' || outro?.ending === 'cold' ? outro.ending : null;
    const base = (track.bpm != null || track.musicalKey != null)
      ? { bpm: track.bpm ?? null, key: track.musicalKey ?? null }
      : { bpm: rec?.bpm ?? null, key: rec?.musicalKey ?? null };
    // Boundary keys: what mixCompat compares across a seam (opening key when
    // incoming, ending key when outgoing). Falls back to the dominant key.
    const keyRanges = track.keyRanges ?? rec?.keyRanges ?? null;
    const durSec = Number(track.duration) || rec?.durationSec || 0;
    const durMs = durSec > 0 ? durSec * 1000 : null;
    return {
      ...base,
      keyStart: mix.openingKeyFrom(keyRanges, base.key),
      keyEnd: mix.endingKeyFrom(keyRanges, durMs, base.key),
      ending,
      // Sung ending: feeds vocal-tail exit shaping + the chop-over-voice veto.
      vocalTail: mix.vocalTailFor(outro?.vocalRanges, outro?.startMs),
    };
  }

  // Stash a clamped gain offset toward the loudness target as `gainDb`. Unknown
  // loudness leaves it undefined, so getAnnotatedUri emits no liq_amplify.
  // Resolved by music/loudness.ts because the stem-blend render bakes in the
  // SAME figure (#1240).
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

  // The model's recent transition choices, oldest first — fed into the pick
  // event turn so it can see and break its own habit.
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

  // Push an instrumental bed into dj_queue ahead of `item` so the DJ talks over
  // the bed rather than the song. Sets item.bedded, which is only how
  // onBedStarted finds the item whose link to air — the light duck is
  // onBedStarted's `overBed` to give, since the flag means "handed over" while
  // the marker means "on air". Must run after the link's WAV is rendered (its
  // real length is the input) and before the track URI is written. Silent no-op
  // on every other path.
  async maybePushBed(item: QueueItem) {
    const cfg = settings.get()?.beds;
    if (!cfg?.enabled) return;
    // Already bedded: a crash between the bed push and the track write leaves
    // this item unsent, and the recovery re-drain would queue a second bed.
    if (item.bedded) return;
    // Two separately gated reasons (bed-policy.BedReason): a LINK beds when the
    // DJ would outlast the incoming intro, a REQUEST beds because the opening
    // bars are the requester's (#1465). `requestedBy` is the discriminator, not
    // introKind — every request path pushes 'dj-speak' and so does the studio.
    const reason: bedPolicy.BedReason = item.requestedBy ? 'request' : 'link';
    if (reason === 'request') {
      if (!cfg.requestIntros) return;
    } else if (item.introKind !== 'link') {
      // An unrequested 'dj-speak' intro: no listener's opening bars to protect.
      return;
    }
    if (!item.introWav || !item.introScript || item.introAired) return;

    // What the bed crosses in under: the item just ahead in the FIFO queue,
    // else the track on air now.
    const idx = this.upcoming.indexOf(item);
    const predecessor = (idx > 0 ? this.upcoming[idx - 1]?.track : null) ?? this.current?.track ?? null;

    // Evaluate airIntro's stale-link drop here first: by air time the bed is
    // committed and would air naked. The predecessor is final once this drains.
    if (shouldDropStaleLink(item, predecessor)) return;

    try {
      const voiceMs = speechDurationMs(item.introWav, item.introScript);
      // The ramp budget is a property of the INCOMING track: how long may the
      // DJ talk before trampling its vocal? Resolved through vocal-runway,
      // which owns both halves of the answer — the three-state read of
      // vocalRanges (track object first, else the library row: queued items
      // hold only id/title/artist) and the shift onto the TRIMMED timeline,
      // since the drain may be about to cut a leading blank off this very
      // track. Leaving that shift out here made the bed and the link's own
      // budget disagree about one track, with the prompt told the runway is 2s
      // while the bed decision still thought it was 8s and declined a bed the
      // link needed. Both readers go through the one module now (#1622), and
      // null (unknown) / Infinity (instrumental) come back untouched.
      const budgetMs = vocalRunwayMs(item.track);
      // `reason` outranks the budget entirely for a request (bed-policy), so
      // the trim correction above only ever decides a LINK's bed.
      if (!bedPolicy.bedWanted(voiceMs, budgetMs, cfg, reason)) return;

      // The bed's marker starts at cross-FEED time, one predecessor exit canvas
      // before the bed is dominant, so the bed must be sized to carry that entry
      // cross and onBedStarted holds the link for it. 0 is legitimate (hard-cut
      // station), so guard with isFinite, never `|| 10`.
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
      // What the bed costs this item's air time: bedSec less the two crosses it
      // OVERLAPS. Recorded because the bed never enters `upcoming`, so a forecast
      // walking the queue cannot see it (#1574).
      item.bedDelaySec = Math.max(0, Math.round((bedSec - entryCrossSec - crossSec) * 100) / 100);
      this._lastBed = pick.name;

      // The bed replaced the seam these entry-side effects were validated for,
      // so they come off (radio.liq reads them off the incoming track, which
      // would apply them to the bed). Same for the armed stinger, which would
      // fire mid-ramp under the DJ. Exit-side stamps govern this track's own
      // ending and stay.
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
      // Report the tail: it is the term that makes bedSec outgrow a short bed
      // file, so it explains a later "no bed long enough".
      const tailSec = Number.isFinite(cfg.tailSec) ? cfg.tailSec : bedPolicy.BED_TAIL_SEC;
      this.log('beds', `bed "${pick.name}" ${bedSec}s (${entryCrossSec}s entry cross) → ${tailSec}s tail → ${crossSec}s ramp into "${item.track?.title}" (${Math.round(voiceMs / 1000)}s link, ${why})`);
    } catch (err) {
      // A bed is a garnish — never let it cost the station a track.
      this.log('error', `Bed push failed: ${(err as Error).message}`);
    }
  }

  applyMixTransition(item: QueueItem) {
    const persona: Persona | null = settings.getEffectivePersona();
    if (!item?.track) return;
    // Persona flipped out of DJ mode between pick and drain: no flag may survive.
    if (!persona?.djMode) {
      if (item.track.sweep || item.track.washout || item.track.blend || item.track.dissolve || item.track.chop || item.track.loop) this.stripEffect(item.track, 'dj mode off');
      return;
    }

    // Per-effect operator switches (#1565), enforced here because a switch can
    // flip between pick and drain. Targeted rather than stripEffect(): one pick
    // may legitimately carry an entry AND an exit gesture.
    for (const kind of TRANSITION_EFFECTS) {
      if (item.track[kind] && !settings.effectEnabled(kind)) {
        delete item.track[kind];
        this.log('mix', `${kind} dropped (switched off in settings)`);
      }
    }

    const idx = this.upcoming.indexOf(item);
    const prevTrack = (idx > 0 ? this.upcoming[idx - 1]?.track : null) || this.current?.track || null;
    // Stable within this synchronous drain action. Do not re-read queue state
    // after an await merely to decorate an exit-effect diagnostic.
    const successorTrack = idx >= 0 ? this.upcoming[idx + 1]?.track ?? null : null;
    const exitEffectMeta = {
      exitTrackId: item.track.id ?? null,
      exitTrackTitle: item.track.title ?? null,
      successorTrackId: successorTrack?.id ?? null,
      successorTrackTitle: successorTrack?.title ?? null,
    };
    if (!prevTrack) {
      // Nothing on-air to validate against: an effect would garnish silence.
      if (item.track.sweep || item.track.washout || item.track.blend || item.track.dissolve || item.track.chop || item.track.loop) this.stripEffect(item.track, 'no predecessor');
      return;
    }

    const cur = this.mixAnalysisFor(prevTrack);
    const next = this.mixAnalysisFor(item.track);

    // The pair-sized blend is applyPairStamps()' job (#749): liq_cross_duration
    // governs the STAMPED track's own end, and the predecessor is already
    // annotated by now. This function does only track-intrinsic work.
    const maxSec = settings.get()?.crossfadeDuration ?? null;

    // The agent proposes an effect, the data disposes; a rejected flag is
    // stripped so getAnnotatedUri never stamps it.
    //
    // Auto-arm a washout when the cap will CUT this pick, so the forced mid-song
    // exit sounds intentional. Deterministic, not an LLM choice. Requests are
    // exempt from the cap and so never arm it.
    const capSec = item.requestedBy ? null : settings.effectiveMaxTrackSec();
    const durSec = knownDurationSec(item.track);
    const cappedExit = !!(capSec && durSec > capSec);
    // A DJ-chosen loop exit already covers the capped cut; don't stack the
    // auto-washout on it (radio.liq's washout-wins precedence would eat the
    // loop). The auto-arm honours the washout switch too (#1565) — the cut
    // still happens, just as a plain crossfade.
    if (cappedExit && !item.track.washout && !item.track.loop && settings.effectEnabled('washout')) {
      item.track.washout = true;
      item.track.washoutAuto = true;
    }

    // Ending-aware exit canvas: a fade rides out long, a cold end cuts tight.
    // Skipped for a capped exit (the real ending never airs) and overwritten by
    // a washout/loop stamped below.
    if (!cappedExit) {
      const outro = item.track.outro ?? (item.track.id ? library.get(item.track.id)?.outro : null) ?? null;
      if (outro) {
        // Measure the wind-down to the end that will AIR, not the tagged one:
        // an untrimmed durSec counts silence we are about to cut as ramp.
        const trimEndSec = silenceTrim.resolveSilenceTrim(item.track).cueOutSec;
        const endSec = trimEndSec != null && durSec > 0
          ? Math.min(durSec, trimEndSec)
          : (trimEndSec ?? durSec);
        const windDownSec = endSec > 0 && Number.isFinite(outro.startMs)
          ? Math.max(0, endSec - outro.startMs / 1000)
          : null;
        // Body loudness for tail-drop shaping (track object, else library row).
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

    // When the seam INTO this pick is a pre-rendered clip, entry-side effects
    // would garnish a transition that no longer happens live. Exit-side
    // gestures stay: this pick's own end is still a live seam.
    if (item.stemSeam) {
      for (const k of ['sweep', 'blend', 'dissolve', 'chop'] as const) {
        if (item.track[k]) {
          delete item.track[k];
          this.log('mix', `${k} dropped (the seam into this pick is a rendered stem blend)`);
        }
      }
    }

    // No cooldown by design: pacing is the DJ's call. Anti-streak instead —
    // the third consecutive IDENTICAL choice is stripped. The ledger records
    // what the model ASKED FOR, not what aired, so a stuck model stays stripped
    // until it genuinely varies; auto (length-cap) washouts are invisible to it.
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
    // Entry-side effects garnish the PREVIOUS track's ending, so they yield to
    // a loop exit already armed there. radio.liq enforces the same precedence;
    // stripping here keeps the pick log honest.
    if (item.track.sweep && prevTrack.loop) {
      delete item.track.sweep;
      this.log('mix', 'sweep dropped (previous track already exits through a loop)');
    }
    if (item.track.sweep && !mix.effectAllowedFor('sweep', cur, next)) {
      delete item.track.sweep;
      this.log('mix', 'sweep dropped (tracks too compatible — beat-blend beats a sweep)');
    }
    if (item.track.sweep) this.log('mix', `sweep armed → ${item.track.title}`);
    // blend is the sweep's mirror: it only works between COMPATIBLE tracks,
    // since the handover exposes a clash rather than hiding it.
    if (item.track.blend && prevTrack.loop) {
      delete item.track.blend;
      this.log('mix', 'blend dropped (previous track already exits through a loop)');
    }
    if (item.track.blend && !mix.effectAllowedFor('blend', cur, next)) {
      delete item.track.blend;
      this.log('mix', 'blend dropped (tracks clash — a handover needs a compatible pair)');
    }
    if (item.track.blend) this.log('mix', `blend armed → ${item.track.title}`);
    // dissolve (reverb wash): beatless ambience only earns its place across a
    // measurable clash. Yields to a washout on the previous track's exit —
    // both shape the same outgoing ending.
    if (item.track.dissolve && (prevTrack.washout || prevTrack.loop)) {
      delete item.track.dissolve;
      this.log('mix', `dissolve dropped (previous track already exits through a ${prevTrack.washout ? 'washout' : 'loop'})`);
    }
    if (item.track.dissolve && !mix.effectAllowedFor('dissolve', cur, next)) {
      delete item.track.dissolve;
      this.log('mix', 'dissolve dropped (tracks too compatible — a blend keeps the groove a wash would kill)');
    }
    if (item.track.dissolve) this.log('mix', `dissolve armed → ${item.track.title}`);
    // chop (crossfader cut): the gate period is one beat of the OUTGOING track,
    // stamped on this pick because the predecessor's annotation has already
    // been sent. Yields to a previous-track washout, same as the dissolve.
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
    // loop (exit loop): stamps ride the flagged track itself — its
    // liq_cross_duration is the canvas, its liq_loop_bar one bar of its OWN
    // tempo. Hard data gate: it needs a measured BPM for a bar length.
    if (item.track.loop && !(next.bpm && next.bpm > 0)) {
      delete item.track.loop;
      this.log('mix', 'loop dropped (no measured tempo — a loop needs a bar length)');
    }
    if (item.track.loop) {
      item.track.crossSec = mix.loopCrossSecondsFor(next, maxSec);
      item.track.loopBar = mix.loopBarFor(next.bpm);
      this.log('mix', `loop armed on own exit of "${item.track.title}"${successorTrack ? ` before "${successorTrack.title}"` : ''}: ${item.track.crossSec}s canvas, ${item.track.loopBar}s bar`, exitEffectMeta);
    }
    if (item.track.washout) {
      item.track.crossSec = mix.washoutCrossSecondsFor(next, maxSec);
      item.track.washoutDelay = mix.washoutDelayFor(next.bpm);
      const why = item.track.washoutAuto ? ' (length-cap exit)' : '';
      this.log('mix', `washout armed${why} on own exit of "${item.track.title}"${successorTrack ? ` before "${successorTrack.title}"` : ''}: ${item.track.crossSec}s canvas, ${item.track.washoutDelay}s tap`, exitEffectMeta);
    }
    const effectFired = !!(item.track.sweep || item.track.washout || item.track.blend || item.track.dissolve || item.track.chop || item.track.loop);

    // Transition FX, spaced by the chattiness ladder; never over a
    // sweep/washout. Only ARMED here — the drain runs a full track before the
    // seam this stinger is sized for; onTrackStarted fires it at that seam.
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

  // Seconds of BED queued ahead of this item that remainingUntilItemAirs cannot
  // see: a bed goes straight to next.txt and is never an `upcoming` entry, so
  // uncounted it lands a boundary cut a whole link late (#1574). Same chain the
  // forecast walks; a part-played bed is bounded by BOUNDARY_TOLERANCE_SEC.
  bedDelayBeforeItemAirs(item: QueueItem): number {
    const idx = this.upcoming.indexOf(item);
    if (idx < 0) return 0;
    let delay = Number(item.bedDelaySec) || 0;
    for (const ahead of this.upcoming.slice(0, idx)) {
      if (!ahead.sent) continue;
      delay += Number(ahead.bedDelaySec) || 0;
    }
    return delay;
  }

  // Not private: scripts/show-boundary-drain.test.ts drives the exemptions and
  // the cap interaction through it, the same way it reaches applyPairStamps.
  resolveBoundaryCut(
    item: QueueItem,
    durSec: number,
    trim: { cueInSec: number | null; cueOutSec: number | null },
    maxDurationSec: number | null,
  ): showBoundary.BoundaryCut | null {
    if (item.requestedBy) return null;
    const untilAirs = this.remainingUntilItemAirs(item);
    if (untilAirs == null) return null;
    const startMs = Date.now() + (untilAirs + this.bedDelayBeforeItemAirs(item)) * 1000;
    if (!showBoundary.fadeAtShowEndActive(new Date(startMs))) return null;
    // The span that would actually air, after the cap and the trimmed tail —
    // never the tagged duration, which would invent an overshoot the cap
    // already prevents.
    const early = positiveCues([maxDurationSec, trim.cueOutSec]);
    const playable = playableDurationSec(
      durSec,
      early.length ? Math.min(...early) : null,
      trim.cueInSec,
    );
    if (playable == null || playable <= 0) return null;
    const boundaryMs = showBoundary.nextShowBoundaryMs(startMs, playable);
    const cut = showBoundary.resolveBoundaryCueSec({
      startMs,
      cueInSec: trim.cueInSec ?? 0,
      playableSec: playable,
      boundaryMs,
    });
    if (cut != null) {
      this.log('mix', `show boundary fade: "${item.track.title}" cued out at ${cut.cueOutSec}s — it would have run ${Math.round(cut.overshootSec)}s into the next show`);
    }
    return cut;
  }

  // Stamp (or un-stamp) an armed boundary cut, and return the cue the
  // arbitration below folds in. Two halves of one fact — this track is CUT, not
  // ending: `liq_show_fade` tells the mixer why, and the exit gestures stamped
  // for the ending that will not happen come off HERE as well, since a
  // controller ahead of its broadcast image must not hand an armed loop to a
  // mixer that has never heard of the flag. Safe against the #447 cap's own
  // washout: an armed cut is always at least BOUNDARY_TOLERANCE_SEC earlier
  // than the capped end. Must run BEFORE applyPairStamps, which bails on an
  // armed washout or loop. The no-cut branch CLEARS the flag because it rides
  // the persisted item.track and a crash-recovery re-drain must undo it.
  applyBoundaryStamps(item: QueueItem, cut: showBoundary.BoundaryCut | null): number | null {
    if (cut == null) {
      delete item.track.showFade;
      return null;
    }
    item.track.showFade = true;
    delete item.track.washout;
    delete item.track.washoutAuto;
    delete item.track.washoutDelay;
    delete item.track.loop;
    delete item.track.loopBar;
    return cut.cueOutSec;
  }

  // Whether pair-aware drains are in effect. DJ-mode only: both consumers of
  // the hold no-op without djMode, so holding would cost dj_queue visibility
  // for nothing. Non-DJ personas keep the eager drain byte-for-byte.
  pairDrainActive(): boolean {
    return settings.get().transitions?.pairDrain !== false
      && !!settings.getEffectivePersona()?.djMode;
  }

  // Basenames of rendered transition clips that haven't AIRED yet. A clip rides
  // its outgoing item and airs at that item's END, so `current` counts as
  // pending too. The hourly age sweep skips these — a clip behind a long
  // outgoing track can out-age the sweep window while still queued.
  pendingClipPaths(): Set<string> {
    const names = new Set<string>();
    const collect = (i: { stemBlend?: { clipPath: string } | null } | null | undefined) => {
      if (i?.stemBlend?.clipPath) names.add(basename(i.stemBlend.clipPath));
    };
    collect(this.current);
    for (const u of this.upcoming) collect(u);
    return names;
  }

  // Pair-sized exit blend (#749): size THIS track's exit crossfade for the
  // actual pair. Precedence — washout/loop own their canvases outright, and the
  // ending-aware canvas is narrowed, never widened (the pair value wins only
  // when SHORTER).
  applyPairStamps(item: QueueItem, successor: QueueItem) {
    if (!settings.getEffectivePersona()?.djMode) return;
    if (item.track.washout || item.track.loop) return;
    const cur = this.mixAnalysisFor(item.track);
    const next = this.mixAnalysisFor(successor.track);
    let energyDelta = 0;
    try { energyDelta = energyForDaypart().speed - 1; } catch { /* context optional */ }
    let nextIntroMs = successor.track.introMs;
    if (nextIntroMs == null && successor.track.id) nextIntroMs = library.get(successor.track.id)?.introMs ?? null;
    // Onto the trimmed timeline: size against the runway the successor will
    // actually have on air, not the one its file starts with.
    nextIntroMs = silenceTrim.shiftOnsetMs(successor.track, nextIntroMs);
    const maxSec = settings.get()?.crossfadeDuration ?? null;
    const secs = mix.crossSecondsFor(cur, next, { energyDelta, nextIntroMs, maxSec });
    if (secs == null) return;
    const existing = item.track.crossSec;
    item.track.crossSec = existing != null ? Math.min(existing, secs) : secs;
    this.log('mix', `pair blend ${item.track.crossSec}s: ${item.track.title} → ${successor.track.title}`
      + (existing != null && existing < secs ? ' (ending canvas kept)' : ''));
  }

  // Walk `upcoming` and feed unsent items to Liquidsoap one at a time, spaced
  // so the 1s file-poll doesn't miss any.
  //
  // Pair-aware hold (#749, drain-policy.ts): a track's stamps control the
  // transition at its OWN end, so the tail item is held unsent until any
  // successor is queued behind it. The watcher tick re-runs this; past the hard
  // deadline the item drains with track-intrinsic stamps only.
  async drainToLiquidsoap(force = false) {
    if (this.senderBusy) {
      // A forced drain must not vanish into a busy sender (a render or slow TTS
      // can hold the mutex for tens of seconds). Flag it and the in-flight
      // drain re-runs forced on release.
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
        // The clock governing this item's drain is the end of the track it will
        // FOLLOW — the on-air clock extended past sent-but-unaired items ahead,
        // or every other seam loses its pair stamps. `force` (clip-as-track
        // recovery) never holds, but a known successor still earns its stamps.
        const action = force
          ? (hasSuccessor ? 'send-pair' : 'send-intrinsic')
          : drainAction({
              pairDrain: this.pairDrainActive(),
              hasSuccessor,
              remainingSec: this.remainingUntilItemAirs(item),
            });
        if (action === 'hold') break;

        // Render the intro/link WAV ahead of time but do NOT air it here — it
        // would play over the track currently on air (#189); airIntro() writes
        // it when this track starts. Skipped while the station voice is off.
        //
        // BUDGETED against the same clock the drain verdict used (#1409): music
        // commitment must not sit behind optional speech, so past the budget the
        // drain moves on and airIntro renders from the script at air time. A
        // deferred render also costs this link its bed (maybePushBed needs the
        // WAV to measure), which is the accepted trade.
        if (item.introScript && !item.introWav && autoVoiceAllowed()) {
          const budgetSec = introRenderBudgetSec(this.remainingUntilItemAirs(item));
          if (budgetSec === 0) {
            this.log('mix', `Intro render deferred to air time — "${item.track.title}" airs too soon to render ahead`);
          } else {
            // Handlers attach to the render promise ITSELF, not the race, so a
            // render landing after the budget still reaches the item and a late
            // rejection is never unhandled.
            const render = this._introRenders.start(item, () => speak(item.introScript!, {
              kind: item.introKind || 'dj-speak',
              // Voice it as whoever wrote it: speak() would otherwise resolve
              // the persona at DRAIN time, possibly past a show boundary.
              persona: item.introPersona || null,
            }));
            // The tracker turns rejection into a result. This observer owns the
            // item mutation and error log even after the drain stops waiting.
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

        // An operator cancel may have spliced this item out during the render.
        if (!this.upcoming.includes(item)) continue;

        // Shape the transition INTO this track from its compatibility with the
        // one it follows. Gated on djMode and on both tracks being analysed.
        this.applyMixTransition(item);

        // Loudness normalisation, on EVERY track, not just DJ mode.
        await this.applyLoudnessGain(item.track);

        // The bed, if wanted. dj_queue is FIFO, so it goes over BEFORE the
        // track URI below.
        await this.maybePushBed(item);

        const maxDurationSec = item.requestedBy ? null : settings.effectiveMaxTrackSec();
        const itemDurSec = knownDurationSec(item.track);
        const cappedExit = !!(maxDurationSec && itemDurSec > maxDurationSec);

        // Dead-air trim, through the policy module (the auto.m3u rewrite asks
        // the same question). Resolved above the stem-blend attempt because the
        // blend is rendered FROM the regions the trim can remove.
        const trim = silenceTrim.resolveSilenceTrim(item.track);

        // Show-boundary fade (#1574). Resolved here for the same two reasons as
        // the trim: it folds into the same cue arbitration below, and a blend
        // mixed from the tail it removes has to be told.
        const boundaryCut = this.resolveBoundaryCut(item, itemDurSec, trim, maxDurationSec);
        const boundaryCueSec = this.applyBoundaryStamps(item, boundaryCut);

        // Pair stamps for this item's own exit, only when the successor is
        // known. Resolved fresh after the awaits above, since a cancel during
        // the render may have removed it.
        let successor: QueueItem | null = null;
        if (action === 'send-pair') {
          successor = this.upcoming[this.upcoming.indexOf(item) + 1] ?? null;
          if (successor) {
            this.applyPairStamps(item, successor);
            // With the pair known, try to upgrade the seam to a pre-rendered
            // blend. Cache-hit-only and deadline-raced inside; null falls back
            // to the plain pair-aware crossfade stamped above.
            try {
              // Recompute the window here rather than reusing the hold
              // decision's: the TTS await between them can run tens of seconds
              // and a stale window lets the render overrun the hard fallback.
              // Both trim edges veto the blend for the same reason outCapped
              // does — the clip is mixed FROM the outgoing tail and incoming
              // head, so a cut inside either makes it describe audio that no
              // longer airs.
              const inTrim = silenceTrim.resolveSilenceTrim(successor.track);
              const blend = await stemBlend.maybeRenderBlend(
                item.track, successor.track, this.remainingUntilItemAirs(item), {
                  // A boundary cut is a capped exit to the blend: same veto.
                  outCapped: cappedExit || boundaryCueSec != null,
                  outTrimEndSec: trim.cueOutSec,
                  inHeadTrimmed: inTrim.cueInSec != null,
                },
              );
              if (blend && this.upcoming.includes(item) && this.upcoming.includes(successor)) {
                // The rendered seam owns this ending: strip exit gestures and
                // cut tight into the clip. Entry-side flags on ITEM garnish the
                // seam into it and are untouched.
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

        // Record the effective early end for the pair-drain deadline math; it
        // rides into `current` when the item airs. Every early end folds in, or
        // the deadline lands late by whatever was cut.
        if (cappedExit) item.cueOutSec = Math.min(item.cueOutSec ?? Infinity, maxDurationSec!);
        if (trim.cueOutSec != null) item.cueOutSec = Math.min(item.cueOutSec ?? Infinity, trim.cueOutSec);
        if (boundaryCueSec != null) {
          item.cueOutSec = Math.min(item.cueOutSec ?? Infinity, boundaryCueSec);
        }
        // Per-attempt identity for proto_subhttp's completion signal, carried
        // as a URL fragment (never sent to the Navidrome origin). Local-file
        // handoffs never enter that protocol and so produce no channel.
        item.resolveProbeId = subsonic.getLocalPath(item.track)
          ? undefined
          : randomBytes(8).toString('hex');
        // Every "stop early" offset arbitrates earliest-wins, as getAnnotatedUri
        // does against the #447 cap. On the way in the stem seam's cue-in is
        // deeper than any leading silence, so latest-wins plays nothing twice.
        const cueOutCandidates = positiveCues([item.stemBlend?.blendStartSec, trim.cueOutSec, boundaryCueSec]);
        const cueInCandidates = positiveCues([item.stemSeam ? item.stemCueInSec : null, trim.cueInSec]);
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
        // Longer than the default 1.5s wait: with a clip following, two
        // back-to-back writes are normal and a missed 1.0s poll must not
        // overwrite an unconsumed handoff.
        await writeHandoff(config.liquidsoap.queueFile, uri, { maxWaitMs: 5000 });
        if (item.stemBlend) {
          // The clip rides behind its outgoing track, annotated as the INCOMING
          // one so now-playing flips at the blend. Reuse the successor the blend
          // was rendered FOR, never a fresh index lookup — a cancel during the
          // writeHandoff above would give the clip an unrelated track's identity.
          if (successor && this.upcoming.includes(successor)) {
            const clipUri = subsonic.getClipUri(successor.track, item.stemBlend.clipPath, stemBlend.CLIP_SEAM_CROSS_SEC);
            await writeHandoff(config.liquidsoap.queueFile, clipUri, { maxWaitMs: 5000 });
          } else {
            // Successor cancelled between render and clip write: skip the clip.
            // The already-annotated early cue_out airs as a plain crossfade, and
            // dropping the flag keeps the sweep's keep-set honest.
            delete item.stemBlend;
            this.log('mix', `stem-blend successor cancelled mid-handoff — clip skipped; "${item.track.title}" exits early into a plain crossfade`);
          }
        }
        item.sent = true;
        this.persist();  // record the sent flag — these are now live in dj_queue

        // `sent` means handed over, NOT playable: Liquidsoap drops an
        // unresolvable request silently (#1405). Fire-and-forget — it sleeps
        // between reads and must not hold the sender mutex.
        void this.verifyPushResolved(item);

        // writeHandoff already waited for the poll to consume the file.
      }
    } finally {
      this.senderBusy = false;
      if (this.pendingForceDrain) {
        this.pendingForceDrain = false;
        void this.drainToLiquidsoap(true);
      }
    }
  }

  // Commit the held pick before an operator skip (#1300 bug 6): under pair-aware
  // drain an empty dj_queue is the normal mid-track state, so a bare telnet skip
  // would fall through to auto.m3u. Force-drain, then wait for the probe to
  // report a RESOLVED request, bounded by SKIP_COMMIT_WAIT_MS. Past it the skip
  // proceeds anyway and the caller reports the miss. Never throws.
  async commitBeforeSkip(): Promise<{ pending: boolean; committed: boolean; waitedMs: number }> {
    if (skipPrepAction(this.upcoming.length) === 'skip-now') {
      return { pending: false, committed: false, waitedMs: 0 };
    }
    const t0 = Date.now();
    // One forced kick covers every held item; a busy sender re-runs it forced
    // on release, so the loop below only observes.
    void this.drainToLiquidsoap(true);
    let headSentAt: number | null = null;
    const deadline = t0 + SKIP_COMMIT_WAIT_MS;
    while (true) {
      const head = this.upcoming[0];
      if (!head) {
        // Everything aired or was cancelled: nothing left to protect.
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

  // Speak without queueing a track. Two channels, picked by kind: 'link' →
  // intro.txt (light duck), else say.txt (heavy duck).
  //
  // `opts.persona` overrides the on-air persona for THIS clip (the mic-pass
  // voices the OUTGOING DJ after the hour has flipped); `opts.meta` merges into
  // the session turn.
  async announce(text, kind = 'announcement', { persona = null, meta = {} }: { persona?: Persona | null; meta?: TurnMeta } = {}) {
    if (!text || !text.trim()) return;
    try {
      const wavPath = await speak(text, { kind, persona });
      // `djTalkOnlyBetweenTracks` (#1485 FR 5b): the talk tick wraps every fire
      // in a talk-air scope, so no flag is threaded and no call site can forget
      // it. Outside a scope (every manual trigger) the mode is 'immediate'.
      if (currentTalkAir() === 'next-track') {
        this.holdForNextTrack(kind, [{ text, wavPath, persona, meta }], { exchange: false });
        return;
      }
      // No bed by construction: announce() queues no track.
      const channel = voiceChannelFor(kind);
      const targetFile = channel === 'intro'
        ? config.liquidsoap.introFile
        : config.liquidsoap.sayFile;
      const seg: SegmentDesc = { kind, channel, text, meta, persona };
      const handoff = await airVoice(targetFile, wavPath, text, voiceGainDb(kind, persona), {
        onQueued: q => this.onQueued(q, seg),
      });
      // Bookkeeping runs when the words reach the stream, not at handoff
      // (#1382). A mixer that writes no marker resolves immediately with a null
      // stamp, which is the old timing byte for byte.
      this.onSpoken(handoff, seg);
    } catch (err) {
      this.log('error', `Announce failed: ${(err as Error).message}`);
    }
  }

  // The pre-air half of the post-air bookkeeping below: announce that speech is
  // COMING. A callback into airVoice because the commitment happens inside it,
  // before the caller's handoff resolves — landing early is the whole point.
  // Nothing is logged or persisted: this is a forecast, not a record.
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
        this.noteHandoverSpeech(kind);
        session.appendTurn({
          role: 'segment',
          kind,
          text,
          // Live-edge, so a LISTENER-facing consumer adds stream.bufferSeconds
          // (#1114). Absent when unmeasured, never zeroed.
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

  // Air a short multi-voice exchange (guest-show banter). Every line renders to
  // a WAV FIRST, all-or-nothing, so a TTS failure can't strand half a
  // conversation on air; the clips then go back-to-back through the serialised
  // say.txt chain. Each line is logged and stored tagged with its speaker.
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
    // Deferred as ONE segment, not N, so the boundary hears the whole exchange.
    if (currentTalkAir() === 'next-track') {
      this.holdForNextTrack(
        kind,
        rendered.map(l => ({ text: l.text, wavPath: l.wavPath, persona: l.persona, meta: {} })),
        { exchange: true },
      );
      return true;
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
    // One webhook for the whole exchange: per-line events would read as five
    // separate segments downstream.
    webhooks.notify('dj.say', {
      text: rendered.map(l => `${l.persona?.name || 'DJ'}: ${l.text}`).join('\n'),
      kind,
    });
    return true;
  }

  // Defer a spoken segment to the NEXT track boundary (station idents have no
  // real-time constraint, so a transition beats ducking a song mid-vocal). The
  // WAV renders now, keeping TTS latency off the air path; onTrackStarted airs
  // it on the light-duck intro channel. With djTalkOnlyBetweenTracks on, every
  // scheduled segment reaches the same slot via announce()/announceExchange().
  async announceAtNextTrack(text, kind = 'announcement', { persona = null, meta = {}, daypart = null }: { persona?: Persona | null; meta?: TurnMeta; daypart?: string | null } = {}) {
    if (!text || !text.trim()) return;
    try {
      const wavPath = await speak(text, { kind, persona });
      this.holdForNextTrack(kind, [{ text, wavPath, persona, meta }], { exchange: false, daypart });
    } catch (err) {
      this.log('error', `Deferred announce failed: ${(err as Error).message}`);
    }
  }

  // Claim the one deferred slot — the single place it is taken, by all three
  // ways in.
  //
  // The daypart stamp is applied here rather than per caller, so every deferred
  // segment carries the guard: a clip that waits across a daypart boundary is
  // dropped at air rather than reading the wrong part of the day. `null` means
  // the clip made no clock claim to refuse (station clock off) and fails open.
  //
  // Replacing an unaired segment is the rule, and it is logged: the talk-slot
  // planner should have held the second row, so a segment paid for in tokens
  // and TTS and then deleted must be visible.
  holdForNextTrack(
    kind: string,
    clips: PendingVoice['clips'],
    { exchange = false, daypart }: { exchange?: boolean; daypart?: string | null } = {},
  ) {
    if (!clips.length) return;
    const superseded = this._pendingVoice;
    this._pendingVoice = {
      kind,
      clips,
      daypart: daypart ?? stationIdDaypartStamp(getClockContext().spokenDaypart, speakClockAllowed()),
      exchange,
      t: Date.now(),
    };
    if (superseded) {
      this.log('scheduler',
        `Dropped pending ${superseded.kind} — a ${kind} took the next track boundary instead`);
    }
    this.log('scheduler', `Holding ${kind} for the next track boundary`);
  }

  // A rendered segment waiting for the next boundary, or null. Unaired talk is
  // invisible to getLastTalkBreakAt(), and the enqueue time lets the talk
  // scheduler bound its hold (#1419, #1500, #1539).
  pendingVoiceTalk(): PendingTalk | null {
    const p = this._pendingVoice;
    return p ? { kind: p.kind, queuedAt: p.t } : null;
  }

  // Discard a scheduled-but-unaired deferred segment. A mic-pass supersedes an
  // ident (both name the station and the shows); the next cron fire replaces it.
  dropPendingVoice(reason: string) {
    const p = this._pendingVoice;
    if (!p) return;
    this._pendingVoice = null;
    this.log('scheduler', `Dropped pending ${p.kind} — ${reason}`);
  }

  // Index in `upcoming` of the item Liquidsoap is reporting, or -1. subsonic_id
  // first, title+artist for items predating the id annotation. Shared with
  // airPendingVoice so no second matcher can drift out of step.
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

  // Air the boundary-deferred segment, if one is pending. Not at every
  // boundary: one already carrying the track's own link belongs to that line
  // (#1258). A clip older than PENDING_VOICE_MAX_AGE_MS is dropped rather than
  // aired with a stale clock reference; the next cron fire replaces it.
  async airPendingVoice(np: NowPlaying | null = null) {
    // A mic-pass pending from an earlier roll takes this boundary. The
    // same-tick case (the roll happens later in onTrackStarted) is caught by
    // the matching dropPendingVoice call over there.
    if (session.pendingHandoff()) {
      this.dropPendingVoice('the show handoff covers this boundary');
      return;
    }
    const p = this._pendingVoice;
    if (!p) return;
    // Staleness first, so a busy stretch can't keep re-deferring a dead ident.
    if (pendingVoiceStale(p.t, Date.now())) {
      this.dropPendingVoice('waited too long for a track boundary');
      return;
    }
    // A daypart offered at generation can cross its boundary while the WAV
    // waits. Rendered words can't be corrected, so fail silent like the link
    // clock-drift guard. No stamp means no clock claim, so it stays eligible.
    const liveDaypart = getClockContext().spokenDaypart;
    if (stationIdDaypartDrifted(p.daypart, liveDaypart)) {
      this.dropPendingVoice(`daypart changed from "${p.daypart}" to "${liveDaypart}" before air`);
      return;
    }
    // This boundary already speaks: the track's own line can't be moved, the
    // ident is generic, so the rendered WAV just waits for the next one.
    // voiceAllowed/wavExists cover airIntro's own drop paths — holding for a
    // boundary that will turn out silent trades one voice for none. Both are
    // synchronous, keeping the decision ahead of the first await.
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
    // Vocal-aware timing (#1622 FR 5a). This clip lands on the HEAD of the
    // track that just started, on the light-duck intro channel — the same
    // runway a pick's link is trimmed against by enforceIntroBudget, and until
    // now the one placement that was never asked about it. A clip that would
    // still be talking when the singer comes in keeps its slot and takes the
    // NEXT boundary, exactly as the busy-boundary hold above does: nothing is
    // regenerated, nothing is dropped here, and the existing staleness check at
    // the top of this method is what bounds the wait. Why the lever is timing
    // rather than a trim, and why a long segment is deliberately unaffected,
    // are in broadcast/vocal-runway.ts.
    //
    // `incoming` carries the queued item when this boundary is one of ours; an
    // auto.m3u track never enters `upcoming`, so fall back to the id `np`
    // reports — the measurement is a library read either way, and an
    // unidentifiable track resolves to "unknown", which airs.
    const runwayTrack = incoming?.track ?? (np?.subsonic_id ? { id: np.subsonic_id } : null);
    const runwayMs = vocalRunwayMs(runwayTrack);
    // The whole segment, not the first clip: an exchange is deferred as ONE
    // segment and airs back-to-back, so what has to fit the runway is the sum.
    // speechDurationMs (clip + lead-in + duck tail) is the same figure the bed
    // decision budgets a link at, so the two agree about one clip.
    const clipMs = p.clips.reduce((sum, c) => sum + speechDurationMs(c.wavPath, c.text), 0);
    if (!segmentFitsRunway(clipMs, runwayMs)) {
      this.log('scheduler',
        // runwayMs is necessarily finite here — null (unknown) and Infinity
        // (instrumental) both fit, so only a measured onset can refuse.
        `Holding ${p.kind} — vocals enter "${np?.title || 'the incoming track'}" at ${Math.round(Number(runwayMs) / 1000)}s, inside this ${Math.round(clipMs / 1000)}s segment`);
      return;
    }
    this._pendingVoice = null;
    // The reaper deletes old WAVs. A partially reaped exchange airs what
    // survives rather than nothing.
    const clips = p.clips.filter(c => existsSync(c.wavPath));
    if (!clips.length) return;
    for (const clip of clips) {
      try {
        // Deferred segments ride the INTRO file whatever their kind, since the
        // channel is a fact about the boundary. An exchange line keeps its
        // SPEAKER attribution, which windowMessages/prompt-memory key off.
        const seg: SegmentDesc = p.exchange
          ? { ...exchangeSegment(clip, p.kind), channel: 'intro' }
          : { kind: p.kind, channel: 'intro', text: clip.text, meta: clip.meta, persona: clip.persona };
        const handoff = await airVoice(config.liquidsoap.introFile, clip.wavPath, clip.text, voiceGainDb(p.kind, clip.persona), {
          onQueued: q => this.onQueued(q, seg),
        });
        this.onSpoken(handoff, seg);
      } catch (err) {
        this.log('error', `Air pending voice failed: ${(err as Error).message}`);
      }
    }
    // One webhook for the whole exchange, at air time. A single-clip segment's
    // event rides onSpoken like every other.
    if (p.exchange) {
      webhooks.notify('dj.say', {
        text: clips.map(c => `${c.persona?.name || 'DJ'}: ${c.text}`).join('\n'),
        kind: p.kind,
      });
    }
  }

  // Air a queued item's track-tied intro/link, at the moment its track starts,
  // so the voice lands over the RIGHT song (#189). The WAV was rendered by the
  // drain; this writes it to the duck channel and does the usual post-air
  // bookkeeping.
  //
  // `overBed` is the CALLER's statement that a bed is feeding the music chain
  // (onBedStarted saw the marker), never read off item.bedded — that flag only
  // means a bed URI was handed over, and in the failure case the song itself
  // starts and the line takes the heavy duck like any other request intro.
  async airIntro(item: QueueItem, predecessor: Track | null = null, { overBed = false }: { overBed?: boolean } = {}) {
    // Station voice off: backstop for an item queued before the switch flipped.
    if (!autoVoiceAllowed()) return;
    if (!item || item.introAired) return;
    if (!item.introWav && !item.introScript) return;
    item.introAired = true;
    // Stale back-announce net: links are written forward-looking, so this only
    // fires when the model named `linkPrev` and something bumped that track out
    // of the just-played slot. Rendered audio can't be re-cut, so drop it.
    if (shouldDropStaleLink(item, predecessor)) {
      this.log('link-skip',
        `Dropped stale link before "${item.track?.title}" — it named "${item.linkPrev!.title}" but "${predecessor?.title || 'another track'}" actually played first`);
      this.persist();
      return;
    }
    // Stale-CLOCK net, same trade (#1314): if the seam lands far from the
    // forecast the line was written against, its stated time is wrong.
    if (linkClockDrifted(item.linkClockAt, Date.now())) {
      const driftSec = Math.round((Date.now() - item.linkClockAt!) / 1000);
      this.log('link-skip',
        `Dropped link before "${item.track?.title}" — written to air at ${new Date(item.linkClockAt!).toISOString()}, `
        + `but this seam is ${Math.abs(driftSec)}s ${driftSec > 0 ? 'later' : 'earlier'}, so any clock it states is wrong`);
      this.persist();
      return;
    }
    // The WAV can be missing two ways: reaped after ~1h, or never rendered
    // (voice switch off at drain time). The script survives either way, so
    // render now — introAired is already set, so this can't double-air.
    if (!item.introWav || !existsSync(item.introWav)) {
      if (!item.introScript) return;
      // The drain may have stopped WAITING for the pre-render. Reuse that one
      // job: local workers are serial, and cloud engines bill twice.
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
          // Same persona the script was written under; speak() would otherwise
          // resolve at AIR time, past a show boundary.
          persona: item.introPersona || null,
        });
      } catch (err) {
        this.log('error', `Intro WAV render at air time failed: ${(err as Error).message}`);
        return;
      }
    }
    const kind = item.introKind || 'dj-speak';
    // Channel follows what the clip plays OVER, not its kind (#1382).
    const channel = voiceChannelFor(kind, { overBed });
    const targetFile = channel === 'intro'
      ? config.liquidsoap.introFile
      : config.liquidsoap.sayFile;
    try {
      // Same persona the WAV was rendered under: the gain trim is per-persona,
      // so re-resolving here applies one DJ's trim to another DJ's audio.
      const seg: SegmentDesc = {
        kind,
        channel,
        text: item.introScript!,
        persona: item.introPersona || null,
        // Attribute the turn so windowMessages() can name a speaker who was not
        // the session's own persona.
        meta: item.introPersona
          ? { personaId: item.introPersona.id, personaName: item.introPersona.name }
          : {},
      };
      const handoff = await airVoice(targetFile, item.introWav, item.introScript || '', voiceGainDb(kind, item.introPersona || undefined), {
        onQueued: q => this.onQueued(q, seg),
      });
      // Not deferred: introAired is set and must reach disk either way.
      this.persist();
      this.onSpoken(handoff, seg);
    } catch (err) {
      this.log('error', `Air intro failed: ${(err as Error).message}`);
    }
  }

  // Play a pre-rendered sound effect UNDER the DJ voice, straight to sfx.txt
  // (no TTS). `underVoice` offsets the write by VOICE_LEADIN_MS so the stinger
  // lands with the DJ's first word rather than during the silent pre-roll;
  // transition stingers leave it false and fire at the crossfade.
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

  // Air a jingle NOW, the on-demand counterpart to the rotate. Manual trigger,
  // so it ignores jingleRatio. Not the sfx path: a jingle rides the music chain
  // as its own full-level item with no length cap, where an effect is mixed
  // under the programme and bounded by SFX_MAX_SEC.
  //
  // Its own handoff file and priority request.queue, ahead of dj_queue, so a
  // queued track can't delay the press; Liquidsoap keeps it unavailable while
  // voice or a bed is live so it wins the next SAFE boundary.
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
  //
  // `rotate` marks a handoff made by the AUTOMATIC rotate rather than by an
  // operator (#1619). It changes exactly one thing — which budget the press is
  // counted against — so the write, the de-duplication, the booth log and the
  // session turn stay identical and a jingle is one kind of event on air
  // however it was decided. See PENDING_ROTATE_JINGLE_MAX for why the budgets
  // are separate rather than shared or reserved.
  async playJingle(filename: string, { rotate = false }: { rotate?: boolean } = {}) {
    if (!filename) throw new Error('Jingle filename is required');
    const path = await jingles.getPath(filename);
    if (!path) throw new Error(`Unknown jingle: ${filename}`);
    this.retirePendingJingles();
    // Asked across BOTH callers: a rotate must not stack on a clip an operator
    // just pressed, and an operator pressing the clip the rotate is holding is
    // the same double-announcement accident either way.
    if (this._pendingJingles.has(filename)) return { ok: false as const, reason: 'already-queued' as const };
    const inFlight = [...this._pendingJingles.values()].filter(p => p.rotate === rotate).length;
    if (inFlight >= (rotate ? PENDING_ROTATE_JINGLE_MAX : PENDING_JINGLE_MAX)) {
      return { ok: false as const, reason: 'queue-full' as const };
    }
    await writeHandoff(config.liquidsoap.jingleFile, jingles.jingleUri(path), { maxWaitMs: 5000 });
    this._pendingJingles.set(filename, { at: Date.now(), rotate });
    // The sidecar's own script, not the hashed filename: every other segment
    // turn in the booth log and the DJ's chat history carries prose, and
    // `jingle_a1b2c3d4.wav` reads as noise next to them (playSfx logs its
    // effect NAME for the same reason).
    const label = (await jingles.list()).find(j => j.filename === filename)?.text || filename;
    this.log('jingle', `"${label}" queued — airs at the next safe boundary`);
    session.appendTurn({ role: 'segment', kind: 'jingle', text: label });
    return { ok: true as const };
  }

  // How many track boundaries have passed since the controller last drew a
  // jingle — the rotate's due-ness, read by the talk tick's `jingle` row
  // (broadcast/jingle-rotate.ts owns the decision itself).
  rotateJingleTracksSince(): number {
    return this._tracksSinceJingle;
  }

  // Start the count again from zero. Called when the rotate CHANGES HANDS to
  // the controller (#1619, via broadcast/jingle-rotate.ts's owner subscriber):
  // the counter runs on every boundary regardless of owner — onTrackStarted has
  // no business branching on a setting — so a station that has been up for
  // hours on the default 'mixer' is already holding a count far past the ratio,
  // and without this the very next talk tick after the toggle fires a stinger,
  // on top of the mixer's own rotate, which has not restarted yet. Flipping the
  // switch should start a clean N-track cycle.
  resetRotateJingleCount() {
    this._tracksSinceJingle = 0;
  }

  // Draw the AUTOMATIC jingle — the rotate radio.liq used to run on its own
  // (#1619). Everything about the airing is the manual path's: the same single
  // writer, the same de-duplication, the same priority queue, the same booth
  // log and session turn, so a jingle is one kind of event on air however it
  // was decided. What differs is only WHO decided, and that decision has
  // already been made by the talk-slot planner before this is called — the row
  // stood down for the ident, the quiet gap and the pending clip up there, not
  // here, so this stays free of a second copy of any of it.
  //
  // The counter resets on the HANDOFF, not on air: the jingle reaches
  // jingle-now.txt now and Liquidsoap places it at the next safe boundary, so
  // counting from here is what keeps "1 every N tracks" a count of tracks
  // rather than a count of tracks plus however long the mixer held the press.
  //
  // It resets whether or not a clip was actually drawn, and that is the
  // mixer's behaviour rather than a shortcut: radio.liq's rotate is gated by
  // `source.available`, so a jingle that came due at a boundary where the gate
  // was shut was SKIPPED, not banked — "skipping a jingle is the cheaper miss",
  // in that file's own words, and the station runs slightly under the
  // configured ratio. Banking it here instead would leave the row due on every
  // subsequent minute, holding the seam against the segment director until an
  // empty library was filled or a pending press aged out (up to half an hour).
  // So the offer is spent, the reason is logged, and the next one is N tracks
  // away.
  async playRotateJingle(): Promise<boolean> {
    this._tracksSinceJingle = 0;
    const filename = pickRotateJingle(
      (await jingles.list()).map(j => j.filename),
      this._lastRotateJingle,
    );
    if (!filename) {
      this.log('scheduler', '[jingle] rotate skipped — the jingle library is empty');
      return false;
    }
    const res = await this.playJingle(filename, { rotate: true });
    if (!res.ok) {
      this.log('scheduler', `[jingle] rotate skipped — "${filename}" ${res.reason}`);
      return false;
    }
    this._lastRotateJingle = filename;
    return true;
  }

  // Retire presses that have been heard, or that are old enough that they never
  // will be. A mixer restart empties jingle_now_queue and loses the request
  // silently, so every entry has to expire on its own — the button must never
  // wedge shut on bookkeeping.
  retirePendingJingles() {
    const now = Date.now();
    for (const [name, p] of this._pendingJingles) {
      if (now - p.at > PENDING_JINGLE_TTL_MS || jingleAiredAtMs(name) >= p.at) {
        this._pendingJingles.delete(name);
      }
    }
  }

  // Called by the now-playing watcher when Liquidsoap reports a new track.
  onTrackStarted(np: NowPlaying | null) {
    if (!np || !np.title) return;
    const key = `${np.subsonic_id || ''}|${np.title}|${np.artist || ''}`;
    if (key === this.lastSeenKey) return;

    // Metadata matching a NOT-YET-SENT item means a rendered clip annotated as
    // that track is airing while the track never reached Liquidsoap. Consuming
    // it as played would orphan the track, so force-drain (bypassing the pair
    // hold) and leave lastSeenKey unset for the track's real fire.
    if (np.subsonic_id && this.upcoming.some(u => !u.sent && u.track.id === np.subsonic_id)) {
      this.log('scheduler', `"${np.title}" fired while its queue item was still unsent — force-draining it (clip-as-track guard)`);
      void this.drainToLiquidsoap(true);
      return;
    }
    this.lastSeenKey = key;
    // The clock the handover ordering rule runs on (#1576): a count of songs,
    // not a timer. Incremented before airPendingVoice so anything this boundary
    // airs is measured against the boundary it aired AT.
    this._trackStarts++;
    // The rotate's own clock (#1619). Only real MUSIC boundaries reach here —
    // a bed branches before now-playing.json's title gate and a jingle is
    // captured outside music_meta entirely — so this counts the same thing
    // radio.liq's `rotate(weights=[1, jingle_ratio()])` counted, and the
    // controller can draw the stinger the mixer used to draw itself.
    this._tracksSinceJingle++;

    // Air any boundary-deferred segment, unless this boundary already carries
    // the incoming track's own link (#1258). `np` is passed so it sees that item
    // before the splice below. Fire-and-forget: must not stall the watcher tick.
    void this.airPendingVoice(np);

    // Snapshot the outgoing track before the history roll mutates `current`:
    // scrobble.onTrackEvent needs the previous play and its start time.
    const outgoingPrev = this.current
      ? { track: this.current.track, startedAt: this.current.startedAt }
      : null;

    // Roll previous current into history
    if (this.current) {
      const endedAt = new Date().toISOString();
      this.history.unshift({ ...this.current, endedAt });
      this.history = this.history.slice(0, 50);
      // The rolling 24h sidecar the picker's recents window reads; `history` is
      // capped at 50 (~3h), too short for the observed repeat interval.
      const t = this.current.track;
      if (t) {
        this._recentPlays.unshift({
          id: t.id || null,
          title: t.title || null,
          artist: t.artist || null,
          // For the album cooldown (#1485 FR 3). Compilation flags are NOT
          // carried: albumKey exempts on the CANDIDATE side, and both sides
          // must key alike.
          album: t.album || null,
          endedAt,
        });
        this._recentPlays = this._recentPlays.slice(0, config.queue.recentPlaysMax);
        this.persistRecentPlays();
      }
    }

    // Same matcher airPendingVoice used above, so the two agree on the item.
    const idx = this.matchUpcomingIndex(np);

    if (idx >= 0) {
      // FIFO, so `idx > 0` means Liquidsoap already consumed those items (a
      // restart missed their transitions). Splice them or they linger forever.
      const consumed = this.upcoming.splice(0, idx + 1);
      if (idx > 0) {
        this.log('scheduler',
          `Dropped ${idx} queue item(s) Liquidsoap played during the downtime`);
      }
      const item = consumed[consumed.length - 1];
      const source = item.aiPicked ? 'ai' : 'request';
      this.current = { ...item, startedAt: new Date().toISOString(), source };
      // A pre-render is keyed by the queued item and `current` is a spread
      // clone, so carry the lifecycle across before airIntro reuses it.
      this._introRenders.transfer(item, this.current);
      this.log('playing', `${np.title} — ${np.artist}`, { requestedBy: item.requestedBy, source });
      // In sync: clear any dj_queue-empty desync streak.
      this._emptyDjQueueStreak = 0;
      // The stinger armed at drain fires HERE, where the crossfade it was sized
      // for is airing. Re-gated on the live toggle.
      if (item.transitionSfx && settings.get().sfx?.enabled) {
        void this.playSfx(item.transitionSfx);
      }
      // Air this track's intro now it is on air (#189). Fire-and-forget: the
      // writeHandoff can block for maxWaitMs and must not stall the watcher
      // tick. Uses the live `this.current` so introAired lands on the tracked
      // object, and passes the REAL predecessor for the stale-link drop.
      void this.airIntro(this.current, this.history[0]?.track || null);
    } else {
      // Untracked play (auto playlist or jingle). Sent items may no longer be in
      // dj_queue, so reconcile.
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

    // Stamped onto the durable play record and the event log, so history can
    // answer "what show was this on" without correlating session archives.
    const onAirShow = session.getSession()?.show || null;

    // The anchor each pick trace hangs off.
    logEvent('track.play', {
      title: this.current.track.title,
      artist: this.current.track.artist || null,
      // Carried so backfillRecentPlaysFromEvents can rebuild album keys after a
      // restart; without it the album cooldown forgets most of its window.
      album: this.current.track.album || null,
      source: this.current.source,
      requestedBy: this.current.requestedBy || null,
      show: onAirShow?.name || null,
    });

    // Durable play history (library.db `plays`). Fire-and-forget: a failed
    // insert must not stall the watcher tick.
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

    // `sourceTrackId` is the music backend's id, so a relay can resolve the
    // exact library item rather than fuzzy-matching artist+title (#1250). Null
    // for untracked plays. Kept separate from `source` (how it got queued),
    // which existing relays branch on.
    const trackPayload = {
      title: this.current.track.title,
      artist: this.current.track.artist || null,
      album: this.current.track.album || null,
      sourceTrackId: this.current.track.id || null,
      source: this.current.source,
      requestedBy: this.current.requestedBy || null,
    };

    // Fire-and-forget; never blocks the picker path. The optional listener gate
    // fails CLOSED like scrobble: silent skip when gated and the count is unknown.
    const gated = !!settings.get()?.webhooksPolicy?.trackPlayListenerGated;
    if (gated) {
      const listeners = presentListeners();
      if (listeners !== null) {
        webhooks.notify('track.play', { ...trackPayload, listeners });
      }
    } else {
      webhooks.notify('track.play', trackPayload);
    }

    // Fire-and-forget. Internally gated on listener count (fail-closed) and
    // per-backend enable flags.
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

    // Auto-DJ: with nothing queued, hand a track-started event to the session
    // agent. Fire-and-forget — the pick lands in dj_queue before this track
    // ends. With nobody listening the pick is skipped and Liquidsoap coasts on
    // auto.m3u; the watcher still fires here, so the first transition after a
    // listener returns re-enters.
    const isAutonomous = this.current.source === 'auto' || this.current.source === 'ai';
    if (this.autoPick && this.upcoming.length === 0 && !this.pickerBusy && djCallsAllowed()) {
      this.runPickCycle({ isAutonomous });
    }
  }

  // One full DJ pick cycle: session roll, programme plan, persona handoff, link
  // cadence, pick. `pickAnchorItem` lets maybeDeadlinePick run the same cycle
  // against the HELD item this selection is intended to follow — `current` is
  // one track too early there for the event text, run seed and back-announce.
  // This is a captured pick-cycle anchor, not a promise that no request can
  // append behind the held item while the asynchronous selection is running.
  // Fire-and-forget; pickerBusy is the reentry guard.
  runPickCycle({ isAutonomous, pickAnchorItem = null }: { isAutonomous: boolean; pickAnchorItem?: QueueItem | null }) {
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
        // A pick airs when the track it FOLLOWS ends, so near a show boundary
        // the rules to pick by are the NEXT show's; PICK_SHOW_LOOKAHEAD probes
        // a little past the expected start.
        //
        // The lead is what REMAINS of the on-air track, never its full duration
        // — this cycle also runs mid-track from the deadline backstop and boot
        // recovery, where the elapsed part would cross the boundary early
        // (#1205). A held pick anchor adds that track's length instead.
        //
        // This ONE date drives the whole boundary sequence below (roll, episode
        // plan, mic-pass, episode hook), so no second date can disagree with it.
        const leadSec = pickLeadSec(
          this.remainingSecOnAir(),
          pickAnchorItem ? knownDurationSec(pickAnchorItem.track) : null,
        );
        let showAt: Date | null = null;
        if (leadSec != null) {
          showAt = new Date(Date.now() + (leadSec + PICK_SHOW_LOOKAHEAD_SEC) * 1000);
        }
        const ctx = await getFullContext(showAt ?? undefined);
        this.onSessionRolled((await session.maybeRoll(ctx)).id);
        // Before the mic-pass, so a handoff into a programme show can weave the
        // episode angle into its greeting.
        try {
          await programme.ensurePlan(ctx);
        } catch (err) {
          this.log('error', `Programme plan failed: ${(err as Error).message}`);
        }
        // If the roll crossed a persona boundary, air the mic-pass before the
        // incoming DJ's first pick. Guarded so a failure never blocks the next
        // track. A still-unaired ident is dropped first: airPendingVoice ran
        // earlier this tick, before the roll existed to be seen.
        try {
          // The ordering rule (#1576): a show that just signed off owes the
          // listener one closing track. Asked only when a mic-pass is pending,
          // so this cycle counts at most one declined opportunity. A held
          // mic-pass stays PENDING, bounded by its own HANDOFF_MAX_AGE_MS.
          const pendingMicPass = !!session.pendingHandoff();
          if (pendingMicPass && this.closingTrackHolds()) {
            // A real opportunity passed up: this cycle would have aired it.
            this.noteHandoverOpportunityDeclined();
            this.log('scheduler',
              'Holding the show handover — the outgoing DJ just signed off, so a closing track plays first');
          } else if (pendingMicPass) {
            this.dropPendingVoice('the show handoff covers this boundary');
            // Identity looks ahead; the CLOCK must not. The mic-pass airs now,
            // so its prompt clock would run minutes fast on `ctx`'s showAt
            // (#864's failure). Keep show/mood/festival from the look-ahead,
            // take date/clock/time from the live moment.
            const live = await getFullContext();
            await djAgent.runPersonaHandoff(this, {
              ...ctx, at: live.at, date: live.date, clock: live.clock, time: live.time,
            });
          }
        } catch (err) {
          this.log('error', `Persona handoff failed: ${(err as Error).message}`);
        }
        // Open the episode unless the hourly cron already did (first call site
        // wins; the beat flag makes the other a no-op).
        try {
          // This IS a drain/boundary cycle, so an intro held here genuinely
          // passed up an opportunity (#1576).
          await programme.onSessionSettled(this, ctx, undefined, { opportunity: true });
        } catch (err) {
          this.log('error', `Programme episode hook failed: ${(err as Error).message}`);
        }
        await djAgent.runTrackEvent(this, ctx, {
          wantLink,
          showAt,
          pickAnchor: pickAnchorItem?.track ?? null,
          anchorPrior: pickAnchorItem ? (this.current?.track ?? null) : null,
        });
      } catch (err) {
        this.log('error', `DJ track event failed: ${(err as Error).message}`);
      } finally {
        this.pickerBusy = false;
      }
    })();
  }

  // Pair-drain deadline routine, run every watcher tick: when the on-air track
  // nears its end and the next one is held without a successor, pick that
  // successor so the drain can send the held item pair-aware.
  //
  // Fires ONLY for the item airing immediately next (head of `upcoming`, and the
  // only unsent item), or every tick would run the pipeline ahead unbounded.
  // Past the hard deadline the drain's intrinsic path owns the endgame.
  maybeDeadlinePick() {
    if (!this.autoPick || this.pickerBusy || !djCallsAllowed()) return;
    if (!this.pairDrainActive()) return;
    const rem = this.remainingSecOnAir();
    if (!shouldDeadlinePick(rem)) return;
    // Attempt cooldown: the tick re-enters every 1.5s, so a fast-failing pick
    // would re-fire dozens of times. A success stops matching on its own.
    if (Date.now() - this._deadlinePickAt < DEADLINE_PICK_COOLDOWN_SEC * 1000) return;
    if (this.upcoming.length === 0) {
      // Nothing queued this close to the end: the track-start pick failed or
      // never fired. Same backstop pick as onTrackStarted's.
      const isAutonomous = this.current?.source === 'auto' || this.current?.source === 'ai';
      this._deadlinePickAt = Date.now();
      this.runPickCycle({ isAutonomous });
      return;
    }
    const head = this.upcoming[0];
    const unsent = this.upcoming.filter(i => !i.sent);
    if (head.sent || unsent.length !== 1 || unsent[0] !== head) return;
    // The held head needs a successor. Links only ride autonomous seams; a
    // request brings its own intro.
    this._deadlinePickAt = Date.now();
    this.runPickCycle({ isAutonomous: !head.requestedBy, pickAnchorItem: head });
  }

  // Did the pushed item become a playable request? (#1405) Liquidsoap drops an
  // unresolvable one silently, and the reconcile sweep needs ~3 auto tracks to
  // notice. Reads proto_subhttp's outcome for this exact handoff; dj_queue
  // MEMBERSHIP is not usable, since a resolving request may be visible or
  // popped for prefetch. Never throws: a safety net over the drain, not part
  // of it.
  async verifyPushResolved(item: QueueItem) {
    const probeId = item.resolveProbeId;
    if (!probeId) return;

    for (let read = 0; read < PUSH_PROBE_MAX_READS; read++) {
      await sleep(PUSH_PROBE_INTERVAL_MS);
      const outcome = await liquidsoapControl.subhttpProbeOutcome(probeId);

      const verdict = probeVerdict({
        // Aired, cancelled or reconciled away: no longer ours to verify.
        stillQueuedLocally: !!item.sent && this.upcoming.includes(item),
        outcome,
      });
      if (verdict === 'pending') continue;
      if (verdict === 'abandon') return;
      if (verdict === 'resolved') {
        // The push landed. Reuse the reconcile sweep's flag and let that sweep
        // own the item from here.
        item.confirmedInLiquidsoap = true;
        this._resolveFailStreak = 0;
        return;
      }
      this.onPushResolveFailed(item);
      return;
    }
  }

  // A push Liquidsoap never resolved: drop it and re-pick now, so a bad URL
  // costs seconds of auto playlist rather than ~3 tracks.
  onPushResolveFailed(item: QueueItem) {
    const idx = this.upcoming.indexOf(item);
    if (idx < 0) return;  // raced with a cancel/air between verdict and action
    this.upcoming.splice(idx, 1);
    this._resolveFailStreak++;
    this.persist();

    const who = item.requestedBy ? ` (requested by ${item.requestedBy})` : '';
    this.log('error',
      `Liquidsoap never resolved "${item.track?.title || 'unknown'} — ${item.track?.artist || 'unknown'}"${who}: it left dj_queue without airing. The music source returned an error instead of audio, or the file is missing/unreadable — check the broadcast log for a "protocol.subhttp" line and the music server's own log. Dropped from the queue.`);

    // A dead origin fails every re-pick the same way, each costing an LLM call
    // for a track that cannot air. Past the budget, auto.m3u covers the slot.
    if (!repickAfterFailure(this._resolveFailStreak)) {
      this.log('scheduler',
        `${this._resolveFailStreak} unresolvable picks in a row — holding off on re-picks; the auto playlist covers the slot until the next track boundary`);
      return;
    }

    // Same gate as onTrackStarted's auto-DJ block.
    if (this.autoPick && this.upcoming.length === 0 && !this.pickerBusy && djCallsAllowed()) {
      this._deadlinePickAt = Date.now();  // this IS a pick attempt — stamp the backstop's cooldown
      const isAutonomous = this.current?.source === 'auto' || this.current?.source === 'ai';
      this.runPickCycle({ isAutonomous });
    }
  }

  // Reconcile `upcoming` against the live dj_queue. Drops items confirmed
  // present at least once and now gone; items never yet seen are kept, so a
  // just-sent pick survives until Liquidsoap's next poll. An empty dj_queue is
  // handled by the consecutive-empty-reads guard below.
  async reconcileWithDjQueue() {
    const sentItems = this.upcoming.filter(i => i.sent);
    if (sentItems.length === 0) {
      this._emptyDjQueueStreak = 0;
      return;
    }

    try {
      const liveIds = await liquidsoapControl.getDjQueueIds();

      // A single empty read is ambiguous (mid-poll, a mixer restart, or a
      // popped item whose metadata never matched), so count consecutive
      // empties. The counter advances only on an authoritatively empty queue,
      // so a jingle or an artist-string mismatch resets it rather than trips it.
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

  // Operator cancel of a not-yet-aired track. A sent item is pulled out of
  // dj_queue over telnet FIRST and only spliced once Liquidsoap confirms, so a
  // failed removal never half-cancels. A track that already left dj_queue
  // refuses with 'already-playing'; /dj/skip is the tool for that.
  async removeUpcoming(trackId: string): Promise<{ ok: true } | { ok: false; reason: 'not-queued' | 'already-playing' }> {
    const item = this.upcoming.find(i => i.track?.id === trackId);
    if (!item) return { ok: false, reason: 'not-queued' };
    return this.removeUpcomingItem(item);
  }

  // The cancel itself, addressed by ITEM rather than by track id.
  //
  // Split out for the block cancel (#1622 FR 4), which holds the exact items it
  // means to remove and must not re-resolve them by id: a block can legitimately
  // carry the same track twice (`allowDuplicate` is how an operator press gets
  // past the #619 guard), and `find(i => i.track.id === …)` would then cancel
  // the first copy twice and leave the second queued. Every telnet pull-back and
  // both stem cascades stay here, in one place, for both callers.
  async removeUpcomingItem(item: QueueItem): Promise<{ ok: true } | { ok: false; reason: 'not-queued' | 'already-playing' }> {
    if (!this.upcoming.includes(item)) return { ok: false, reason: 'not-queued' };
    const trackId = item.track?.id || '';

    if (item.sent) {
      const { rid, bedRid } = await liquidsoapControl.resolveDjQueueRidWithBed(trackId);
      if (!rid || !(await liquidsoapControl.removeFromDjQueue(rid))) {
        return { ok: false, reason: 'already-playing' };
      }
      // The bed ahead of this track is its own dj_queue entry with no
      // subsonic_id, so the id-keyed removal above can't see it and it would
      // air as a voiceless instrumental. Best-effort: the cancel already won.
      if (item.bedded && bedRid) {
        const removed = await liquidsoapControl.removeFromDjQueue(bedRid).catch(() => false);
        if (removed) this.log('beds', `removed the bed queued ahead of cancelled "${item.track?.title}"`);
        else this.log('error', `orphan bed left in dj_queue after cancelling "${item.track?.title}"`);
      }
    }

    // A rendered clip queued for this track carries its identity and would
    // still air. Best-effort: a clip already being prepared can't be pulled,
    // and the predecessor's early cue_out then airs as an abrupt crossfade.
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

    // …and the OUTGOING half: the clip behind this track was mixed from ITS
    // tail but carries the successor's identity, so cancelling leaves an orphan
    // and the successor's head-skip cuts an intro no clip fronts. Pull the clip
    // and, while the successor is unsent, clear its seam stamps. An already-sent
    // successor keeps them: its cue_in is annotated and gone.
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
            // The clip stays queued, so the successor keeps its head-skip;
            // only the entry into the clip is abrupt.
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

  // Cancel what remains of an operator block (#1622 FR 4) — the inverse of the
  // one press that queued it.
  //
  // PARTIAL BY DESIGN. `removeUpcomingItem` refuses an item Liquidsoap has
  // already taken out of `dj_queue` ('already-playing'), and on a thirty-track
  // block the head is very often exactly that. Refusing the whole cancel over
  // it would leave the operator pulling twenty-nine rows by hand, which is the
  // failure this exists to prevent; so it removes everything it can and reports
  // what it could not. The one committed track plays out — there is no cancel
  // for a track on its way to air, and `/dj/skip` is that tool.
  //
  // Walks a SNAPSHOT in queue order: each removal splices `upcoming`, so
  // iterating the live array would skip every other item.
  async removeUpcomingBlock(blockId: string): Promise<{ removed: number; kept: number; label: string | null }> {
    const members = this.upcoming.filter(i => i.block?.id === blockId);
    if (!members.length) return { removed: 0, kept: 0, label: null };
    const label = members[0].block?.label ?? null;
    let removed = 0;
    let kept = 0;
    for (const item of members) {
      const result = await this.removeUpcomingItem(item);
      if (result.ok) removed++;
      else kept++;
    }
    this.log('scheduler',
      `operator cancelled the rest of "${label}" — ${removed} track${removed === 1 ? '' : 's'} removed`
      + (kept ? `, ${kept} already committed to the mixer and will play out` : ''),
      { blockId, removed, kept });
    return { removed, kept, label };
  }

  // When will this queued item reach air? A FORECAST, and named as one.
  //
  // Deliberately NOT `remainingUntilItemAirs`, which walks only the SENT chain
  // ahead of an item. That is right for its own caller — the drain only ever
  // asks about the first UNSENT item, so nothing unsent is ever ahead of it,
  // and the skip there is a defensive no-op. It is wrong here: this answers a
  // listener's "when does my request play", where an unsent album track sitting
  // in front of them is very much going to play first. Two questions, two
  // walks, both stated — rather than one walk that means different things to
  // its two callers.
  //
  // Null when unknowable, and that is the whole of its error handling: no
  // start stamp (boot, recover, an untracked auto play), or any item ahead with
  // no usable duration. A caller that cannot get an answer says nothing, which
  // is the pre-existing behaviour on every surface that reads this.
  //
  // IT COUNTS THE BED, and any future walk of this queue must too. A bed is
  // written straight to `next.txt` by `maybePushBed` and is never an `upcoming`
  // entry, so a clock that walks the queue sails straight past it — the #1574
  // failure, where an uncounted bed put the show-boundary cut a whole link late.
  // `bedDelayBeforeItemAirs` is that measurement and is reused rather than
  // re-walked: it sums this item's OWN bed (which plays immediately ahead of it)
  // plus the beds of SENT items ahead. An UNSENT item ahead legitimately
  // contributes zero — its bed is decided at ITS drain and has not been pushed
  // yet — so the two walks agree by construction.
  //
  // Both callers are understated by a miss here, in the direction that matters:
  // the listener wait notice would say a request is closer than it is, on the
  // one surface it exists to make honest, and `runsPastShowChange` would
  // under-report the overrun, which reads as "this fits" when it does not.
  airForecastSec(item: QueueItem): number | null {
    const idx = this.upcoming.indexOf(item);
    if (idx < 0) return null;
    let remaining = this.remainingSecOnAir();
    if (remaining == null) return null;
    for (const ahead of this.upcoming.slice(0, idx)) {
      let d = Number(ahead.track?.duration) || 0;
      if (!d && ahead.track?.id) d = Number(library.get(ahead.track.id)?.durationSec) || 0;
      if (!d) return null;
      const playable = playableDurationSec(d, ahead.cueOutSec ?? null, ahead.cueInSec ?? null);
      if (playable == null) return null;
      remaining += playable;
    }
    return remaining + this.bedDelayBeforeItemAirs(item);
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

  // Shim for call sites that only need ids.
  recentlyPlayedIds(hours = 12): Set<string> {
    return this.recentlyPlayed(hours).ids;
  }

  // The last `n` DISTINCT tracks played — the count-based HARD no-repeat guard,
  // never relaxed. Clock-independent, so a busy hour and a quiet one block the
  // same number of songs. Distinct TRACKS, not rows: the sidecar can hold two
  // entries for one play (recordPlay at track-end, the boot backfill at
  // track-start), collapsed on the title|artist key.
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
      // Already counted (by id or key): the duplicate sidecar row.
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

  // How many LISTENER requests are queued and unaired — what
  // `settings.requests.maxPending` is a bound on.
  //
  // `routes/request.ts` used to count `upcoming.filter(i => i.requestedBy)`
  // inline, and that read every operator push as a listener waiting in line,
  // because `POST /dj/queue-track` pushes `requestedBy: 'studio'` on purpose:
  // that string is the discriminator four air-path exemptions key off (the
  // #447 length cap, the show-boundary cut, the bed's request reason, the
  // sub-crossfade warning), and an explicit operator action wants all four.
  // The cost was paid on a surface with no connection to any of them — six
  // manual Queue presses reached the default `maxPending` of 6 and answered
  // every listener "The request queue's full" for as long as those tracks took
  // to air, with nothing in the refusal or the booth log naming the cause.
  //
  // The fix is one question asked in one place rather than a second meaning
  // hung on `requestedBy`: an operator push carries `operator: true` and is not
  // a request the queue is holding on a listener's behalf. Counting `!sent`
  // would be the wrong narrowing — a sent-but-unaired request is still a
  // listener waiting, and the cap is about how deep the line gets, not about
  // how far down it Liquidsoap has already reached.
  //
  // The on-air track is deliberately NOT counted: `maxPending` bounds what is
  // still waiting, and a request that is playing has been served.
  pendingListenerRequests(): number {
    return this.upcoming.filter(i => i.requestedBy && !i.operator).length;
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

  // Acknowledgement for a request refused by the repeat cooldown. Same on-air
  // split as dedupAck: recentlyPlayedIds includes the track currently playing.
  cooldownAck(trackId: string | null | undefined, title: string): string {
    const onAir = !!trackId && this.current?.track?.id === trackId;
    return onAir
      ? `That one's spinning right now — give it a bit before you ask again.`
      : `"${title}" just spun — give it a rest for a bit.`;
  }

  // Lead-artist keys (artistRootKey) of the slots AROUND the next pick:
  // everything queued and unaired, the track on air, and the last `n` DISTINCT
  // tracks played. Count-based, because this is a question about slots, not
  // hours. The queued side matters because a pick is not always adjacent to the
  // on-air track, and it takes the queue's TAIL, where a pick appends.
  //
  // Sole consumer is the agent path's artist guard (#1251) — hence root keys,
  // where recentArtistsSince feeds the pool picker's raw-key filter. Empty when
  // n <= 0.
  neighbourArtistRoots(n = 0): Set<string> {
    const out = new Set<string>();
    if (!Number.isFinite(n) || n <= 0) return out;
    const add = (artist: string | null | undefined) => {
      const key = artistRootKey({ artist });
      if (key) out.add(key);
    };
    for (const item of this.upcoming.slice(-n)) add(item?.track?.artist);
    add(this.current?.track?.artist);
    // Distinct TRACKS, not rows: a duplicate sidecar row must not burn a slot.
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

  // Lowercased artist names heard in the last `hours` hours. Raising the
  // default narrows the pool fast on a small library.
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

  // Album keys (music/recency.albumKey; compilations key as '' and are exempt)
  // heard inside `hours`, plus every album queued and unaired, plus the one on
  // air.
  //
  // ONE method for BOTH pick paths (#1485 FR 3), so "which albums are too
  // recent" cannot mean two things — hence hours, the shape both paths read
  // without re-deriving it. The queued side is included because a pick is not
  // always adjacent to the on-air track; it takes the WHOLE queue, since all of
  // it airs inside any window worth setting.
  //
  // Empty when hours <= 0, the shipped default, so an upgrade changes nothing.
  recentAlbumKeys(hours = 0): Set<string> {
    const out = new Set<string>();
    if (!Number.isFinite(hours) || hours <= 0) return out;
    // albumKeyFor, not the pure albumKey: a queued pick or a sidecar play row
    // carries no compilation flags, and without the library fill-in a sampler
    // would enter the window it is meant to be exempt from.
    const add = (track: CandidateLike | null | undefined) => {
      const key = albumKeyFor(track || {});
      if (key) out.add(key);
    };
    for (const item of this.upcoming) add(item?.track);
    add(this.current?.track);
    // _recentPlays is newest-first, so the first row past the cutoff ends the
    // walk — same shape as recentArtistsSince.
    const cutoff = Date.now() - hours * 3_600_000;
    for (const p of this._recentPlays) {
      if (new Date(p.endedAt).getTime() < cutoff) break;
      add(p);
    }
    return out;
  }

  // A bed started feeding the music chain: air the link it was pushed for. Has
  // to be an event, since the bed is pushed minutes before it airs. A new
  // `startedAt` in bed-playing.json is the edge; deduped on that value because
  // the file is never deleted and a stale marker must not re-fire. airIntro sets
  // introAired before any await, so song B's own call is already idempotent.
  onBedStarted() {
    // The bed is pushed immediately ahead of its item, so the marker belongs to
    // the first bedded item still waiting to speak. None (the common tick) →
    // skip the disk read.
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

    // _lastBedStartedAt doesn't survive a restart but the marker file does, so
    // an old startedAt on a new process's first ticks is the PREVIOUS bed. Only
    // a marker fresh enough to be from the last tick counts as an edge.
    const startedMs = startedAt * 1000; // liquidsoap time() is unix seconds
    if (Date.now() - startedMs > BED_MARKER_FRESH_MS) return;

    // The marker fires at cross-FEED time, a whole predecessor exit canvas
    // before the bed is dominant (the bed was sized to carry it). Hold the link
    // for what remains so the first words land on the solo bed.
    const waitMs = Math.max(0, startedMs + (item.bedEntrySec || 0) * 1000 - Date.now());
    this.log('beds', `bed on air → airing the link for "${item.track?.title}"${
      waitMs > 0 ? ` in ${(waitMs / 1000).toFixed(1)}s (entry cross)` : ''}`);
    // overBed: the marker IS the bed on air, so this is the one call site that
    // can state it as a fact rather than infer it from item.bedded.
    const fire = () => void this.airIntro(item, this.current?.track || null, { overBed: true });
    if (waitMs > 0) setTimeout(fire, waitMs);
    else fire();
  }

  // Poll now-playing.json every 1.5s and dispatch track changes. Each tick also
  // refreshes the copy getNowPlaying() serves, so the per-listener poll never
  // touches disk.
  startWatcher() {
    const tick = async () => {
      this._nowPlaying = await this.readNowPlayingFromDisk();
      this._nowPlayingFresh = true;
      this.onTrackStarted(this._nowPlaying);
      // Beds ride this tick rather than a poller of their own: 1.5s is already
      // inside the head budget bed-policy sizes the bed with.
      this.onBedStarted();
      // Drain holds are time-gated and push() only drains on mutation, so the
      // clock advancing past a deadline has to re-trigger it from here.
      this.maybeDeadlinePick();
      void this.drainToLiquidsoap();
    };
    void tick();
    setInterval(tick, 1500);
    this.log('scheduler', 'Now-playing watcher started');
  }

  snapshot() {
    const mapItem = (i: QueueItem) => ({
      // Named to match the subsonic_id already public on /now-playing; the
      // admin dash targets rows for DELETE /dj/queue/:trackId with it.
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
      // The operator block this row belongs to (#1622 FR 4), or absent. Carries
      // its own index/size rather than being counted here, so a block half
      // played still reads "9 of 11" instead of shrinking with the queue.
      block: i.block || undefined,
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
      // One operator-facing answer for the imminent FINALISED seam: effect flags
      // sit on opposite sides of the pair and stay proposals until the incoming
      // item drains, so the dashboard must not reverse-engineer precedence.
      nextTransition: nextTransitionLabel(this.current, this.upcoming[0]),
      djLog: this.djLog.slice(0, 50),
      autoPick: this.autoPick,
      autoLink: this.autoLink,
      pickerBusy: this.pickerBusy,
    };
  }

  // Now-playing as Liquidsoap last reported it, from the watcher's in-memory
  // copy; a direct read until the first tick lands (or with no watcher, e.g.
  // one-off scripts). Returns a COPY: callers enrich the object in place and
  // must not leak those fields into the shared cache.
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

// The queue's public surface, for modules that receive the singleton. Type-only,
// so importers pull it without a runtime cycle.
export type QueueApi = InstanceType<typeof Queue>;

export const queue = new Queue();

// Handing the rotate to the controller starts a clean N-track cycle (#1619).
// Registered here rather than called from settings.update() because settings.ts
// already imports broadcast/jingle-rotate.ts and this module imports settings —
// a direct call would close the cycle. It also catches every writer, not just
// the admin route: a backup restore reaches update() directly. Only the switch
// TOWARD the controller matters; going back to the mixer leaves a count nothing
// is reading, and zeroing it would be a change the operator did not ask for.
onJingleRotateOwnerChange(owner => {
  if (owner === 'controller') queue.resetRotateJingleCount();
});
