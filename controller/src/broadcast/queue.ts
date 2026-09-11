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
import { swallowedByCrossfade } from '../util/request-guard.js';
import * as showBoundary from './show-boundary.js';
import * as blocklist from '../music/blocklist.js';
import { artistRootKey, trackKey, type CandidateLike } from '../music/recency.js';
import { albumKeyFor } from '../music/album-facts.js';
import { speak, voiceGainDb } from '../audio/tts.js';
import {
  writeSilentWav,
  discardSilentWav,
  writePauseTalkCommit,
  readPauseTalkCommit,
  discardPauseTalkCommit,
  PAUSE_TALK_DIR,
} from '../audio/wav-silence.js';
import { normalizeForDisplay } from '../audio/speech-text.js';
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
import { speakClockAllowed, stationIdDaypartDrifted, stationIdDaypartStamp } from './clock-policy.js';
import {
  currentTalkAir,
  suppressScheduledSpeechDuringHandoff,
  talkOnlyBetweenTracks,
  withTalkAir,
} from './talk-air.js';
import {
  PAUSE_TALK_ARM_MAX_AGE_MS,
  PAUSE_TALK_EXIT_CROSS_SEC,
  PAUSE_TALK_MARKER_POLL_MS,
  PAUSE_TALK_RECOVERY_AMBIGUITY_MS,
  pauseTalkArmExpired,
  pauseTimelineDelayMs,
  releaseDelayMs,
  resolveTalkPlacement,
  silenceDurationMs,
  wantsPauseTalk,
} from './pause-talk.js';
import {
  inspectPauseVoiceDelivery,
  waitForPauseVoiceClaim,
  waitForPauseVoiceStarted,
} from './queue/pause-voice-delivery.js';
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
  shouldDropCrossSessionLink,
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
  clipDurationMs,
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
  /** A multi-line handoff becomes aired only when its final line reaches the
   * live edge. Single-line handoffs omit this and settle as before. */
  settlesHandoff?: boolean;
}

// A rendered segment waiting for the next track boundary — the one slot behind
// announceAtNextTrack() and airPendingVoice().
//
// `clips` is a LIST because a segment is not always one utterance: a banter
// exchange is several lines in several voices, rendered all-or-nothing and
// aired back to back, and `djTalkOnlyBetweenTracks` (#1485 FR 5b) can defer one
// of those exactly as it defers an ident. It is still ONE segment and one slot
// — the queue never holds two deferred segments, and the talk-slot planner is
// what stops a second one being written while this one waits (see
// talk-scheduler's pendingHolds).
interface PendingVoice {
  kind: string;
  clips: {
    text: string;
    wavPath: string;
    persona: Persona | null;
    meta: TurnMeta;
    settlesHandoff?: boolean;
  }[];
  /** Daypart the model was allowed to claim, or null. stationIdDaypartDrifted
   *  refuses a stale clip on this stamp. */
  daypart: string | null;
  /** Whether the clips are lines of one multi-voice exchange, which decides the
   *  attribution they air under and the single webhook they owe. */
  exchange: boolean;
  /** Enqueue time — the anchor for both the stale drop and the planner's hold. */
  t: number;
  /** A show opted this long skill segment into a real silent break. */
  pauseTalk?: boolean;
  /** Set only once the drain has handed its silence item to Liquidsoap. Its
   *  presence means COMMITTED: the mixer holds a real gap that only this clip
   *  can fill, so no other path may air, drop or replace the segment. */
  pauseId?: string;
  /** When the silence was handed over — the bound on that commitment. */
  pauseArmedAt?: number;
  /** The predecessor's crossfade, which is mixed over the head of the silence
   *  (`cross` sizes a transition from the OUTGOING track's stamp). Budgeted
   *  into the silence and paid back as the release delay. */
  pauseIncomingCrossMs?: number;
  /** Full silent item length, used to reject an old matching marker after a
   *  restart without applying the unrelated bed marker freshness window. */
  pauseSilenceMs?: number;
  /** Stable identity of the track whose seam already owns the silent item.
   *  Recovery uses it to suppress a second hidden item at that same seam. */
  pauseTrackKey?: string;
  /** Net music-timeline delay persisted with the commitment, because a crash
   *  can happen before queue.json snapshots the same value on QueueItem. */
  pauseDelaySec?: number;
  /** The marker matched and this voice has started joining the serialiser. */
  pauseReleasing?: boolean;
  /** Optional effect selected with the line; handed over only when the voice is. */
  sfx?: string | null;
  /** Process-local completion signal. Deliberately omitted by JSON.stringify;
   *  after restart the durable queue owns playout but no dead caller is waiting. */
  onCompleted?: (aired: boolean) => void;
  /** Set only while reconstructing the commitment: recovery waits out an old
   *  mixer's ambiguous read/delete/start interval before deciding the clip was
   *  never published. It may ride the final acknowledgement write harmlessly. */
  pauseRecovered?: boolean;
  /** Durable controller acknowledgement written after the stable delivery id
   *  reached the mixer's start marker and post-air bookkeeping completed. */
  pauseAcknowledgedAt?: number;
  /** Do not air before this instant, even if an estimated final track ends
   * early. Used only by a between-tracks show handoff. */
  notBefore?: number | null;
}

export interface AnnounceOutcome {
  accepted: boolean;
  deferred: boolean;
  /** Resolves true after ordinary post-air bookkeeping runs, false if the held
   *  segment is displaced or cannot be handed over. */
  completed: Promise<boolean>;
}

// Re-exported so every existing `from './queue.js'` import keeps working.
export {
  BACKFILL_DEDUP_MAX_GAP_MS,
  boundaryCarriesTrackVoice,
  playAlreadyRecorded,
  shouldDropCrossSessionLink,
  shouldDropStaleLink,
} from './queue/pure.js';
export { registerSkillKinds } from './queue/kinds.js';
export type { NowPlaying, QueueItem, Track } from './queue/types.js';

// Every cue arbitration in the drain starts the same way: throw out anything
// that is not a real, positive offset, then take the extreme (earliest for a
// cue_out, latest for a cue_in). Shared so a fourth candidate cannot be added
// to one of those lists under a quietly different notion of "real" — which is
// how the cap, the trim and a rendered blend would stop agreeing about the
// tail they all cut.
function positiveCues(values: (number | null | undefined)[]): number[] {
  return values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
}

function pauseTrackKey(item: QueueItem): string {
  return item.track.id ? `id:${item.track.id}` : `track:${trackKey(item.track)}`;
}

// Manual jingle presses that may be pending at once (see playJingle). A bound on
// a runaway loop across different filenames, not a policy on how many
// announcements an operator may line up.
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
// Give the next show a natural seam if one is close, but never let a complete
// handoff pair become a detached greeting several minutes into that show.
const HANDOFF_BOUNDARY_WAIT_MS = 2 * 60_000;

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
  _pendingVoice: PendingVoice | null = null; // one boundary-deferred segment awaiting the next track start — see announceAtNextTrack
  _handoffBoundaryTimer: NodeJS.Timeout | null = null;
  _introRenders = new IntroRenderTracker<QueueItem>(); // timed-out pre-renders stay reusable by airIntro
  // Jingle handoffs made but not yet heard — see playJingle. ONE map for both
  // callers on purpose: the de-duplication question ("is this clip already
  // waiting?") has to be answered across the operator's presses and the
  // automatic rotate together, so a second map would be a second source of
  // truth for it. Only the CAP is per-caller, which is what `rotate` records.
  _pendingJingles = new Map<string, { at: number; rotate: boolean }>();
  _tracksSinceJingle = 0;       // track boundaries since the last controller-drawn jingle — the count radio.liq's rotate used to keep (#1619)
  _lastRotateJingle: string | null = null; // last jingle the controller drew — anti-repeat for jingle-rotate.pickRotateJingle

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
          // The rotate's boundary count (#1619). Snapshotted for the same
          // reason the queue itself is — a controller restart is routine, every
          // `--build controller` is one. This count is absolute: losing it
          // costs up to a full
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
    if (existsSync(config.queue.file)) try {
      const stored = JSON.parse(readFileSync(config.queue.file, 'utf8'));
      // Drop anything queued long enough ago that Liquidsoap has certainly
      // played past it — guards against a stale snapshot from a long downtime
      // resurrecting tracks as permanent "Up next" zombies.
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
    this.recoverPauseTalk();
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

  // The pause commitment is intentionally separate from queue.json: persist()
  // is debounced, while the matching voice has to be durable BEFORE next.txt
  // can hand a real silence to the mixer.
  recoverPauseTalk() {
    const raw = readPauseTalkCommit() as Partial<PendingVoice> | null;
    if (raw?.pauseTalk === true
      && /^[a-f0-9]{16}$/.test(String(raw.pauseId || ''))
      && Number.isFinite(raw.pauseAcknowledgedAt)) {
      void discardPauseTalkCommit();
      this.log('scheduler', `Cleaned acknowledged pause-and-talk delivery for ${raw.kind || 'segment'}`);
      return;
    }
    if (!raw || raw.pauseTalk !== true || typeof raw.kind !== 'string'
      || !/^[a-f0-9]{16}$/.test(String(raw.pauseId || ''))
      || typeof raw.pauseTrackKey !== 'string'
      || !Number.isFinite(raw.pauseDelaySec)
      || !Array.isArray(raw.clips) || raw.clips.length !== 1
      || raw.exchange === true
      || !raw.clips.every(c => c && typeof c.text === 'string' && typeof c.wavPath === 'string')
      || pauseTalkArmExpired(raw.pauseArmedAt, Date.now())) {
      if (raw) void discardPauseTalkCommit();
      return;
    }
    this._pendingVoice = {
      kind: raw.kind,
      clips: raw.clips as PendingVoice['clips'],
      daypart: typeof raw.daypart === 'string' ? raw.daypart : null,
      exchange: false,
      t: Number.isFinite(raw.t) ? Number(raw.t) : Date.now(),
      pauseTalk: true,
      pauseId: raw.pauseId,
      pauseArmedAt: raw.pauseArmedAt,
      pauseIncomingCrossMs: Number.isFinite(raw.pauseIncomingCrossMs)
        ? Math.max(0, Number(raw.pauseIncomingCrossMs)) : 0,
      pauseSilenceMs: Number.isFinite(raw.pauseSilenceMs)
        ? Math.max(0, Number(raw.pauseSilenceMs)) : 0,
      pauseTrackKey: typeof raw.pauseTrackKey === 'string' ? raw.pauseTrackKey : undefined,
      pauseDelaySec: Number.isFinite(raw.pauseDelaySec)
        ? Math.max(0, Number(raw.pauseDelaySec)) : 0,
      sfx: typeof raw.sfx === 'string' ? raw.sfx : null,
      pauseRecovered: true,
    };
    this.log('scheduler', `Recovered committed pause-and-talk break for ${raw.kind}`);
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

  // The text of the most recent between-track link that actually AIRED, or
  // null. djLog entries for voice kinds are written by onSpoken — after the
  // clip reached the stream — which is what makes this the right anchor for
  // announce-mode's alternation (broadcast/announce-line.ts): a link that was
  // composed and then dropped (silence ordered, intro budget, refused pick)
  // never lands here, so the next one can't repeat the form the listener just
  // heard. 'link' is the kind both link paths log under — enqueuePick's
  // introKind and announce()'s own kind.
  getLastLinkText(): string | null {
    for (const entry of this.djLog) {
      if (entry.kind === 'link') return entry.message || null;
    }
    return null;
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
      track, requestedBy, operator, intent, introScript, introKind, introPersona,
      // Links are editorially scoped to the session that wrote them. Preserve
      // the key alongside the persona: persona alone cannot distinguish two
      // adjacent shows hosted by the same DJ.
      introSessionKey: introScript && introKind === 'link' ? session.getSession()?.key ?? null : null,
      aiPicked,
      block: block ?? undefined,
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

  // A request the MIXER will silently eat (#1594). Log only — nothing is
  // declined and nothing is dropped.
  //
  // `cross(duration=d)` buffers d seconds of the outgoing track before it can
  // hand over, so a track whose whole playable span is under d is consumed by
  // that buffer and never sounds; it leaves dj_queue without airing and without
  // an error. The controller cannot see that happen — proto_subhttp's outcome
  // is a curl verdict at resolution time and reports `ready` for any readable
  // file, so verifyPushResolved marks the handoff healthy and the reconcile
  // sweep later logs an unattributed "dropped N stale queue item(s)". The
  // listener gets a silent no with nothing in the booth log naming their
  // request. That is the whole bug being fixed: the operator learns why.
  //
  // Gated on `requestedBy` — the same discriminator as the cap and the boundary
  // cut exemptions above — because a request is the one path deliberately
  // exempt from every length rule the controller owns (maxTrackSeconds,
  // picker.minTrackLengthSeconds), and therefore the only path where a
  // sub-crossfade track is expected to arrive at all. push() is the chokepoint
  // every producer funnels through, so the listener route's three resolutions,
  // the DJ agent's request path, MCP and the studio queue are all covered by
  // this one call — there is no branch in routes/request.ts.
  //
  // The span is the PLAYABLE one, resolved by music/silence-trim.ts: a trimmed
  // head or tail is exactly what the buffer eats, and subtracting cue points
  // here instead is the drift that module exists to prevent.
  //
  // One honest limit, which the LINE ITSELF carries rather than only this
  // comment — the line is what the operator reads. `crossfadeDuration` is the
  // CONFIGURED figure; radio.liq reads liquidsoap_crossfade.txt once at mixer
  // startup, so between a crossfade change and a /restart-mixer the mixer is
  // still buffering the old value while this warning is measured against the
  // new one. Nothing in the controller can read the live figure, and warning
  // against the setting the operator can actually act on is the useful half.
  //
  // THE WHOLE BODY IS INSIDE A try/catch, and that is the load-bearing line
  // here rather than defensiveness. `playableSpanSec` resolves through
  // `library.get` → `db.getTrack`, which makes this the FIRST sqlite read on
  // the request critical path — everything push() touched before it (the
  // blocklist hit, the dedup scan) is in-memory. `library.get` guards
  // `!loaded` but not a DB error, so an unreadable library.db would throw out
  // of push(), out of the route, and turn a listener request into a 500. A
  // purely informational log line may not decide whether a request is queued.
  // The swallow is silent: the operator is already missing this warning, and
  // an error line about the warning that failed to fire is noise about noise.
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
      // What the bed costs this item's air time. bedSec was built as
      // entryCross + head + voice + tail + cross, and both crosses are OVERLAP
      // — the entry one with the predecessor, the exit one with this track —
      // so what is left between them is the only part that pushes this item
      // back. Recorded because the bed never enters `upcoming`, and a forecast
      // that walks the queue therefore cannot see it (#1574).
      item.bedDelaySec = Math.max(0, Math.round((bedSec - entryCrossSec - crossSec) * 100) / 100);
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
      // The tail is reported because it is the part an operator HEARS as a
      // decision (a beat of bare bed) rather than as a fade, and it is the term
      // that makes bedSec outgrow a short bed file — so when the line above
      // says "no bed long enough", this line on the previous bed shows why.
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
    // Persona flipped out of DJ mode between the pick and the drain: the
    // effects gate below never runs, so make sure no flag survives to annotate.
    if (!persona?.djMode) {
      if (item.track.sweep || item.track.washout || item.track.blend || item.track.dissolve || item.track.chop || item.track.loop) this.stripEffect(item.track, 'dj mode off');
      return;
    }

    // Per-effect operator switches (#1565) — the enforcement copy. Both pick
    // paths already refuse to stamp a switched-off gesture, but a switch can be
    // flipped between the pick and this drain, and this is the chokepoint every
    // stamp passes through on its way to getAnnotatedUri.
    //
    // Targeted, not stripEffect(): that drops all six at once, which is right
    // when the whole kit is off (no DJ mode, no predecessor) and wrong here —
    // sweep shapes ENTRY and washout EXIT, so one pick can legitimately carry
    // both and switching off the sweep must not take the washout with it.
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
    // The auto-arm honours the washout switch too (#1565). It is deterministic
    // rather than a DJ choice, but it is the same gesture at the same cost —
    // an operator who switched the washout off did not ask for it back on the
    // capped exits. The cut still happens; it is just a plain crossfade.
    if (cappedExit && !item.track.washout && !item.track.loop && settings.effectEnabled('washout')) {
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
      this.log('mix', `loop armed on own exit of "${item.track.title}"${successorTrack ? ` before "${successorTrack.title}"` : ''}: ${item.track.crossSec}s canvas, ${item.track.loopBar}s bar`, exitEffectMeta);
    }
    if (item.track.washout) {
      item.track.crossSec = mix.washoutCrossSecondsFor(next, maxSec);
      item.track.washoutDelay = mix.washoutDelayFor(next.bpm);
      const why = item.track.washoutAuto ? ' (length-cap exit)' : '';
      this.log('mix', `washout armed${why} on own exit of "${item.track.title}"${successorTrack ? ` before "${successorTrack.title}"` : ''}: ${item.track.crossSec}s canvas, ${item.track.washoutDelay}s tap`, exitEffectMeta);
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

  // Seconds of hidden music-timeline items that remainingUntilItemAirs cannot
  // see. Beds and pause silences go straight to next.txt and are never
  // `upcoming` entries, so omitting either makes listener ETAs optimistic and
  // can land a show-boundary cut a whole spoken break late.
  hiddenDelayBeforeItemAirs(item: QueueItem): number {
    const idx = this.upcoming.indexOf(item);
    if (idx < 0) return 0;
    let delay = (Number(item.bedDelaySec) || 0) + (Number(item.pauseDelaySec) || 0);
    for (const ahead of this.upcoming.slice(0, idx)) {
      if (!ahead.sent) continue;
      delay += (Number(ahead.bedDelaySec) || 0) + (Number(ahead.pauseDelaySec) || 0);
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
    const startMs = Date.now() + (untilAirs + this.hiddenDelayBeforeItemAirs(item)) * 1000;
    if (!showBoundary.fadeAtShowEndActive(new Date(startMs))) return null;
    // The span that would actually air, after the cap and the trimmed tail —
    // never the tagged duration. A track the #447 cap already stops before the
    // boundary has no overshoot to cut, and asking about the raw length would
    // invent one.
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

  // Stamp (or un-stamp) an armed boundary cut on the item, and return the cue
  // the arbitration below should fold in.
  //
  // Two things happen together here because they describe one fact — this
  // track is being CUT, not ending:
  //   * `liq_show_fade` tells the mixer why, so dj_transition drops the seam
  //     back to the plain full-buffer fade;
  //   * the exit gestures stamped for the ending that will not happen come
  //     OFF, upstream, exactly as the stem-blend seam strips them. radio.liq
  //     enforces the same precedence, but the flag is the only thing carrying
  //     it — a controller running ahead of its broadcast image would otherwise
  //     hand an armed loop to a mixer that has never heard of liq_show_fade,
  //     and that branch applies no fader at all, which is the hard stop this
  //     feature exists to avoid.
  //
  // Safe against the #447 cap, which arms a washout of its own: an armed
  // boundary cut is always at least BOUNDARY_TOLERANCE_SEC EARLIER than the
  // capped end (the overshoot test is what arms it), so the ending being
  // stripped is never the cap's.
  //
  // Called BEFORE applyPairStamps, which bails out on an armed washout or loop
  // and would otherwise size the exit canvas for an outro that no longer airs.
  //
  // The no-cut branch CLEARS the flag rather than leaving it: it rides
  // item.track, which persists, so the crash-recovery re-drain (the process
  // died between the URI write and `sent`) must be able to take it back off.
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

        // A pause-talk silence item, if one is waiting. Like beds, it must be
        // written by this drain (the one writer of next.txt) before the track.
        const pauseTalkInserted = await this.maybePushPauseTalk(item);

        // The bed, if wanted. dj_queue is FIFO, so it goes over BEFORE the
        // track URI below.
        if (!pauseTalkInserted) await this.maybePushBed(item);

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

        // Show-boundary fade (#1574): a show built on 20-30 minute material
        // picks one last track minutes before its slot ends and is still
        // playing deep into the next show, so the incoming presenter's opening
        // link airs over the outgoing show's music. Resolve the cut HERE, next
        // to the trim and above the stem-blend attempt, for the same two
        // reasons the trim is: it is one more "stop early" offset that folds
        // into the same arbitration below, and a rendered blend is mixed FROM
        // the tail this would remove, so the blend has to be told.
        const boundaryCut = this.resolveBoundaryCut(item, itemDurSec, trim, maxDurationSec);
        const boundaryCueSec = this.applyBoundaryStamps(item, boundaryCut);

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
                  // A boundary cut is a capped exit as far as the blend is
                  // concerned — same veto, same reason: the clip describes a
                  // tail that will not air.
                  outCapped: cappedExit || boundaryCueSec != null,
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
        if (boundaryCueSec != null) {
          item.cueOutSec = Math.min(item.cueOutSec ?? Infinity, boundaryCueSec);
        }
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
  // `opts.persona` overrides the on-air persona for THIS clip. `opts.meta`
  // merges into the session turn, e.g. tagging a handoff with its speaker.
  async announce(
    text,
    kind = 'announcement',
    { persona = null, meta = {}, pauseTalkEligible = false, sfx: selectedSfx = null }:
      { persona?: Persona | null; meta?: TurnMeta; pauseTalkEligible?: boolean; sfx?: string | null } = {},
  ): Promise<AnnounceOutcome> {
    const safeText = normalizeForDisplay(text || '');
    if (!safeText) return { accepted: false, deferred: false, completed: Promise.resolve(false) };
    if (suppressScheduledSpeechDuringHandoff(kind, session.handoffInProgress())) {
      this.log('scheduler', `Dropped ${kind} — the show handoff has already claimed this boundary`);
      return { accepted: false, deferred: false, completed: Promise.resolve(false) };
    }
    try {
      const wavPath = await speak(safeText, { kind, persona });
      if (suppressScheduledSpeechDuringHandoff(kind, session.handoffInProgress())) {
        this.log('scheduler', `Dropped ${kind} — the show handoff completed while it rendered`);
        return { accepted: false, deferred: false, completed: Promise.resolve(false) };
      }
      const show = settings.resolveActiveShow();
      const pauseTalk = wantsPauseTalk({
        enabled: show?.pauseTalk === true,
        eligible: pauseTalkEligible,
        clipMs: speechDurationMs(wavPath, safeText),
        minSeconds: settings.get()?.pauseTalkMinSeconds,
      });
      // `djTalkOnlyBetweenTracks` (#1485 FR 5b): the talk tick wraps every fire
      // in a talk-air scope, so no flag is threaded and no call site can forget
      // it. Outside a scope (every manual trigger) the mode is 'immediate'.
      const placement = resolveTalkPlacement({ pauseTalk, talkAir: currentTalkAir() });
      if (placement !== 'immediate') {
        let settle!: (aired: boolean) => void;
        const completed = new Promise<boolean>(resolve => { settle = resolve; });
        const accepted = this.holdForNextTrack(kind, [{ text: safeText, wavPath, persona, meta }], {
          exchange: false,
          pauseTalk: placement === 'pause-talk',
          sfx: selectedSfx,
          onCompleted: settle,
          notBefore: kind === 'handoff' ? session.handoffBoundaryAt() : null,
        });
        if (!accepted) settle(false);
        if (accepted && placement === 'pause-talk') void this.drainToLiquidsoap();
        return { accepted, deferred: true, completed };
      }
      // No bed here by construction — announce() speaks without queueing a
      // track, so there is nothing for maybePushBed to have bedded.
      const channel = voiceChannelFor(kind);
      const targetFile = channel === 'intro'
        ? config.liquidsoap.introFile
        : config.liquidsoap.sayFile;
      const seg: SegmentDesc = { kind, channel, text: safeText, meta, persona };
      const handoff = await airVoice(targetFile, wavPath, safeText, voiceGainDb(kind, persona), {
        onQueued: q => this.onQueued(q, seg),
      });
      // Bookkeeping runs when the words reach the stream, not at handoff
      // (#1382). A mixer that writes no marker resolves immediately with a null
      // stamp, which is the old timing byte for byte.
      const completed = this.onSpoken(handoff, seg);
      if (selectedSfx) await this.playSfx(selectedSfx, { underVoice: true });
      return { accepted: true, deferred: false, completed };
    } catch (err) {
      this.log('error', `Announce failed: ${(err as Error).message}`);
      return { accepted: false, deferred: false, completed: Promise.resolve(false) };
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
      const safeText = normalizeForDisplay(text);
      notifyQueued({
        voiceId: q.voiceId,
        kind,
        channel,
        text: safeText,
        durationMs: q.clipMs,
        estimatedAirInMs: q.estimatedAirInMs,
        personaId: persona?.id ?? (meta.personaId as string | undefined) ?? null,
        personaName: persona?.name ?? (meta.personaName as string | undefined) ?? null,
      });
    } catch (err) {
      this.log('error', `Queued-voice notify failed: ${(err as Error).message}`);
    }
  }

  async onSpoken(handoff: VoiceHandoff, {
    kind, channel, text, meta = {}, persona = null, logText = null, legacy = true,
    settlesHandoff = true,
  }: SegmentDesc): Promise<boolean> {
    const airedAt = await handoff.aired;
    try {
      const safeText = normalizeForDisplay(text);
      const safeLogText = logText == null ? safeText : normalizeForDisplay(logText);
      this.log(kind, safeLogText);
      // A handoff remains merely QUEUED until Liquidsoap's live-edge marker
      // confirms that it reached listeners. A multi-line handoff settles on
      // its final line only.
      if (kind === 'handoff' && settlesHandoff) session.markHandoffAired();
      session.appendTurn({
        role: 'segment',
        kind,
        text: safeText,
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
        text: safeText,
        durationMs: handoff.clipMs,
        airedAt,
        legacy,
        personaId: persona?.id ?? (meta.personaId as string | undefined) ?? null,
        personaName: persona?.name ?? (meta.personaName as string | undefined) ?? null,
      });
      return true;
    } catch (err) {
      this.log('error', `Post-air bookkeeping failed: ${(err as Error).message}`);
      return true;
    }
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
    if (suppressScheduledSpeechDuringHandoff(kind, session.handoffInProgress())) {
      this.log('scheduler', `Dropped ${kind} exchange — the show handoff has already claimed this boundary`);
      return false;
    }
    const rendered: { persona: Persona; text: string; wavPath: string }[] = [];
    try {
      for (const l of lines) {
        const text = normalizeForDisplay(l.text || '');
        if (!text) continue;
        const wavPath = await speak(text, { kind, persona: l.persona });
        rendered.push({ ...l, text, wavPath });
      }
    } catch (err) {
      this.log('error', `Exchange render failed: ${(err as Error).message}`);
      return false;
    }
    if (!rendered.length) return false;
    // Deferred as one segment, not as N: the exchange keeps its order and its
    // all-or-nothing rendering, and the boundary hears the whole conversation.
    if (currentTalkAir() === 'next-track') {
      return this.holdForNextTrack(
        kind,
        rendered.map((l, index) => ({
          text: l.text,
          wavPath: l.wavPath,
          persona: l.persona,
          meta: {},
          settlesHandoff: kind === 'handoff' ? index === rendered.length - 1 : undefined,
        })),
        { exchange: true, notBefore: kind === 'handoff' ? session.handoffBoundaryAt() : null },
      );
    }
    for (const [index, l] of rendered.entries()) {
      if (suppressScheduledSpeechDuringHandoff(kind, session.handoffInProgress())) {
        this.log('scheduler', `Dropped ${kind} exchange — the show handoff completed while it rendered`);
        return false;
      }
      try {
        const seg: SegmentDesc = {
          ...exchangeSegment(l, kind),
          settlesHandoff: kind === 'handoff' ? index === rendered.length - 1 : undefined,
        };
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
  // The ident is the row that has always deferred; with
  // `djTalkOnlyBetweenTracks` on (#1485 FR 5b) every scheduled segment reaches
  // the same slot, through announce()/announceExchange() rather than through
  // here. All bookkeeping (djLog → recap/opener anti-repeat, session turn,
  // webhook) happens at AIR time, so the DJ's memory reflects what reached the
  // stream, not what was merely scheduled.
  async announceAtNextTrack(text, kind = 'announcement', { persona = null, meta = {}, daypart = null }: { persona?: Persona | null; meta?: TurnMeta; daypart?: string | null } = {}) {
    const safeText = normalizeForDisplay(text || '');
    if (!safeText) return;
    if (suppressScheduledSpeechDuringHandoff(kind, session.handoffInProgress())) {
      this.log('scheduler', `Dropped ${kind} — the show handoff has already claimed this boundary`);
      return;
    }
    try {
      const wavPath = await speak(safeText, { kind, persona });
      if (suppressScheduledSpeechDuringHandoff(kind, session.handoffInProgress())) {
        this.log('scheduler', `Dropped ${kind} — the show handoff completed while it rendered`);
        return;
      }
      this.holdForNextTrack(kind, [{ text: safeText, wavPath, persona, meta }], { exchange: false, daypart });
    } catch (err) {
      this.log('error', `Deferred announce failed: ${(err as Error).message}`);
    }
  }

  // Take the one deferred slot. The three ways in — an ident's explicit
  // announceAtNextTrack, and announce()/announceExchange() under a 'next-track'
  // talk-air scope — differ only in what they hand over, so the slot is claimed
  // in exactly one place.
  //
  // The DAYPART STAMP is applied here rather than by each caller, so every
  // deferred segment carries the guard and not just the ident that needed it
  // first: a clip that waits across a daypart boundary is dropped at air rather
  // than reading yesterday's part of the day. A caller that already computed
  // the stamp (runStationId, which offers the daypart to the model) passes it;
  // everything else gets the live one. `null` means the clip made no clock
  // claim the guard could refuse — that is what stationIdDaypartStamp returns
  // with the station clock off, and it fails open on purpose.
  //
  // Replacing an unaired segment is still the rule for the ident path this
  // started as (a fresh ident supersedes a stale one). With
  // djTalkOnlyBetweenTracks on it should never happen: the talk-slot planner
  // holds every row while a clip is waiting, precisely so a second scheduled
  // segment is never WRITTEN, let alone dropped on the floor here. It is logged
  // where it does, because a segment paid for in tokens and TTS and then
  // silently deleted is exactly the failure that hold exists to prevent.
  holdForNextTrack(
    kind: string,
    clips: PendingVoice['clips'],
    {
      exchange = false,
      daypart,
      pauseTalk = false,
      sfx: selectedSfx = null,
      onCompleted,
      notBefore = null,
    }: {
      exchange?: boolean;
      daypart?: string | null;
      pauseTalk?: boolean;
      sfx?: string | null;
      onCompleted?: (aired: boolean) => void;
      notBefore?: number | null;
    } = {},
  ): boolean {
    if (!clips.length) return false;
    const superseded = this._pendingVoice;
    // Once the silence handoff has an id it is a committed music-timeline
    // request, not a cancellable forecast. Replacing it would leave a real gap
    // with no matching voice (or release the wrong clip), so the break keeps
    // the slot and this offer is DECLINED — the talk planner should not have
    // offered the minute at all (it sees the hold through pendingVoiceTalk),
    // and the row it belongs to retries inside its own window. Bounded, so a
    // silence that never reaches the mixer cannot pin the slot: past the arm
    // limit the break disarms and this offer is taken normally.
    if (superseded?.pauseId && !pauseTalkArmExpired(superseded.pauseArmedAt, Date.now())) {
      this.log('scheduler', `Declined ${kind} — a pause-and-talk break is committed to this boundary`);
      return false;
    }
    this._pendingVoice = {
      kind,
      clips,
      daypart: daypart ?? stationIdDaypartStamp(getClockContext().spokenDaypart, speakClockAllowed()),
      exchange,
      t: Date.now(),
      pauseTalk,
      sfx: selectedSfx,
      onCompleted,
      notBefore,
    };
    if (kind === 'handoff' && notBefore != null) {
      if (this._handoffBoundaryTimer) clearTimeout(this._handoffBoundaryTimer);
      const pending = this._pendingVoice;
      this._handoffBoundaryTimer = setTimeout(() => {
        this._handoffBoundaryTimer = null;
        if (this._pendingVoice === pending) void this.airPendingVoice();
      }, Math.max(0, notBefore + HANDOFF_BOUNDARY_WAIT_MS - Date.now()));
    }
    if (superseded) {
      superseded.onCompleted?.(false);
      this.log('scheduler',
        `Dropped pending ${superseded.kind} — a ${kind} took the next track boundary instead`);
    }
    this.log('scheduler', `Holding ${kind} for the next track boundary${pauseTalk ? ' as a pause-and-talk break' : ''}`);
    return true;
  }

  // Put a silent, annotated item immediately ahead of the next track. The
  // marker it produces is what releases the actual clip through say.txt; the
  // spoken audio never rides the music path and therefore keeps mic_chain,
  // edge fades, voice-playing timestamps and ordinary post-air bookkeeping.
  async maybePushPauseTalk(item: QueueItem) {
    const p = this._pendingVoice;
    if (!p?.pauseTalk) return false;
    if (p.pauseId) {
      if (p.pauseTrackKey !== pauseTrackKey(item)) return false;
      item.pauseDelaySec = p.pauseDelaySec ?? 0;
      return true;
    }
    // A listener request owns this seam, and a stem blend has already consumed
    // the next track's head. Both fall back to the existing boundary delivery.
    if (item.requestedBy || item.stemSeam) {
      p.pauseTalk = false;
      this.log('scheduler', `Pause-and-talk ${p.kind} falling back to ducked boundary speech — ${item.requestedBy ? 'listener request' : 'stem blend'} owns this seam`);
      return false;
    }
    const clips = p.clips.filter(c => existsSync(c.wavPath));
    if (!clips.length) {
      this.dropPendingVoice('its pause-and-talk clip was reaped before the boundary');
      return false;
    }
    if (p.clips.length !== 1 || clips.length !== 1 || p.exchange) {
      p.pauseTalk = false;
      this.log('scheduler', `Pause-and-talk ${p.kind} falling back to ducked boundary speech — only a single-speaker segment can own a break`);
      return false;
    }
    const pauseId = randomBytes(8).toString('hex');
    const voiceWindowMs = clips.reduce((sum, c) => sum + speechDurationMs(c.wavPath, c.text), 0);
    // The predecessor's crossfade is mixed over the HEAD of this silence, so it
    // is budgeted into the silence and paid back as the release delay. The
    // station setting rather than the outgoing track's own stamp: `cross` reads
    // that stamp off a track already handed to the mixer, and every stamp the
    // controller writes is capped at this figure (music/mix.ts), so the setting
    // is the safe upper bound. Over-estimating costs a little extra silence,
    // which is the recoverable direction.
    const incomingCrossMs = Math.max(0, (settings.get()?.crossfadeDuration ?? 0) * 1000);
    const path = `${PAUSE_TALK_DIR}/${pauseId}.wav`;
    try {
      // Claim before the first await: scheduler/manual work may run while a
      // file is generated, but it may not replace a committed break.
      p.pauseId = pauseId;
      p.pauseArmedAt = Date.now();
      p.pauseIncomingCrossMs = incomingCrossMs;
      const pauseSilenceMs = silenceDurationMs({ voiceWindowMs, incomingCrossMs });
      p.pauseSilenceMs = pauseSilenceMs;
      p.pauseTrackKey = pauseTrackKey(item);
      p.pauseDelaySec = pauseTimelineDelayMs({ silenceMs: pauseSilenceMs, incomingCrossMs }) / 1000;
      // These are entry gestures for the track seam. The silent item replaces
      // that seam, so letting one survive would apply a track transition to
      // silence (or, worse, to the voice break) instead of its intended song.
      if (item.track.sweep || item.track.blend || item.track.dissolve || item.track.chop) {
        const kind = item.track.sweep ? 'sweep' : item.track.blend ? 'blend' : item.track.dissolve ? 'dissolve' : 'chop';
        delete item.track.sweep;
        delete item.track.blend;
        delete item.track.dissolve;
        delete item.track.chop;
        delete item.track.chopPeriod;
        this.log('mix', `${kind} dropped (a pause-and-talk break replaced the transition it was validated for)`);
      }
      if (item.transitionSfx) delete item.transitionSfx;
      await writeSilentWav(path, pauseSilenceMs);
      // This must reach durable state before next.txt can hand the silence to
      // the mixer. queue.json's ordinary 500ms debounce is too late here.
      await writePauseTalkCommit(p);
      const uri = `annotate:subwave_kind="pause-talk",subwave_pause_id="${pauseId}",liq_cross_duration="${PAUSE_TALK_EXIT_CROSS_SEC.toFixed(2)}":${path}`;
      await writeHandoff(config.liquidsoap.queueFile, uri, { maxWaitMs: 5000 });
      item.pauseDelaySec = p.pauseDelaySec;
      this.log('scheduler', `Pause-and-talk break armed for ${p.kind} (${Math.round(voiceWindowMs / 1000)}s voice window)`);
      return true;
    } catch (err) {
      // The silence may already be on disk. disarmPauseTalk unlinks it, so a
      // failed handoff leaves nothing behind for the hourly sweep to carry.
      delete item.pauseDelaySec;
      this.disarmPauseTalk(p, `handoff failed: ${(err as Error).message}`);
      return false;
    }
  }

  // The minimal description of a segment already rendered and waiting for the
  // next track boundary, or null. Talk that has NOT aired yet is invisible to
  // getLastTalkBreakAt(), while the enqueue time lets the talk scheduler respect
  // both that in-flight talk and the queue's finite validity window (#1419,
  // #1500, #1539). Queue remains the owner of eventual stale dropping.
  pendingVoiceTalk(): PendingTalk | null {
    const p = this._pendingVoice;
    return p ? { kind: p.kind, queuedAt: p.t } : null;
  }

  // Discard a scheduled-but-unaired deferred segment. A mic-pass supersedes an
  // ident: sign-off + greeting name the station, the outgoing show and the
  // incoming one, so an ident in front of it is three spoken segments in a row
  // saying overlapping things. The next cron fire schedules a fresh ident.
  dropPendingVoice(reason: string) {
    const p = this._pendingVoice;
    if (!p) return;
    // A committed pause-and-talk break is not a forecast that can be revised
    // away: the mixer already holds a silence item sized for THIS clip, and
    // dropping the clip leaves that gap on air as dead air — the exact failure
    // the feature exists to remove. onPauseTalkStarted owns the segment until
    // the silence airs or the arm expires.
    if (p.pauseId && !pauseTalkArmExpired(p.pauseArmedAt, Date.now())) {
      this.log('scheduler', `Retained pending ${p.kind} (${reason}) — its pause-and-talk silence is already with the mixer`);
      return;
    }
    this._pendingVoice = null;
    p.onCompleted?.(false);
    if (p.pauseId) void discardPauseTalkCommit();
    this.log('scheduler', `Dropped pending ${p.kind} — ${reason}`);
  }

  // Give up on a committed break and fall back to ordinary ducked delivery.
  // The clip is KEPT: the whole fallback story is that a pause-and-talk failure
  // costs the break, never the segment.
  disarmPauseTalk(p: PendingVoice, reason: string) {
    const path = p.pauseId ? `${PAUSE_TALK_DIR}/${p.pauseId}.wav` : null;
    p.pauseTalk = false;
    delete p.pauseId;
    delete p.pauseArmedAt;
    delete p.pauseIncomingCrossMs;
    delete p.pauseSilenceMs;
    delete p.pauseTrackKey;
    delete p.pauseDelaySec;
    delete p.pauseReleasing;
    delete p.pauseAcknowledgedAt;
    if (path) void discardSilentWav(path);
    void discardPauseTalkCommit();
    this.log('scheduler', `Pause-and-talk break disarmed for ${p.kind} — ${reason}; falling back to ducked boundary speech`);
  }

  // Index in `upcoming` of the item Liquidsoap is reporting, or -1. subsonic_id
  // first (reliable), title+artist for items predating the id annotation.
  // Extracted from onTrackStarted so
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
    // A COMMITTED pause-and-talk break owns its segment outright, and this
    // method must not touch it — not to air it, and not to drop it.
    //
    // The window is real: a pair drain (drain-policy.ts) sends two items, so
    // the silence can be armed ahead of item N while item N-1 is still
    // sent-but-unaired, and N-1's start lands here. Airing the clip ducked over
    // N-1 would then leave the silence to play as a 20-90s hole with nothing in
    // it — dead air, and long enough to read as a broken stream. The release is
    // onPauseTalkStarted's, triggered by the mixer's own marker.
    //
    // Bounded so a silence that never reaches the mixer cannot pin the one
    // pending slot: past the arm limit the break disarms and the clip falls
    // through to ordinary ducked delivery below.
    const committed = this._pendingVoice;
    if (committed?.pauseId) {
      if (!pauseTalkArmExpired(committed.pauseArmedAt, Date.now())) return;
      this.disarmPauseTalk(committed, 'its silence never reached the mixer');
    }
    if (session.handoffInProgress() && this._pendingVoice?.kind !== 'handoff') {
      this.dropPendingVoice('the show handoff has already claimed this boundary');
      return;
    }
    // A mic-pass pending from an earlier roll takes this boundary. The
    // same-tick case (the roll happens later in onTrackStarted) is caught by
    // the matching dropPendingVoice call over there.
    if (session.pendingHandoff()) {
      this.dropPendingVoice('the show handoff covers this boundary');
      return;
    }
    const p = this._pendingVoice;
    if (!p) return;
    if (p.notBefore != null && Date.now() < p.notBefore) {
      this.log('scheduler', `Holding ${p.kind} — the show boundary has not arrived`);
      return;
    }
    // Staleness first: a clip too old to air is dropped outright rather than
    // held again below, so a busy stretch can't keep re-deferring a dead ident.
    if (pendingVoiceStale(p.t, Date.now())) {
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
    // A show handoff is time-critical: its own notBefore gate above preserves
    // the true boundary, then it owns the first eligible seam. It must not be
    // turned into an implicit spacer-track policy by waiting for a vocal-safe
    // opening. Ordinary scheduled speech retains the vocal-runway protection.
    if (p.kind !== 'handoff') {
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
    }
    this._pendingVoice = null;
    // The reaper deletes old WAVs; a segment whose clips are all gone has
    // nothing left to air. A partially reaped exchange airs what survives
    // rather than nothing — the alternative is silence on a boundary the
    // planner already spent a slot on.
    const clips = p.clips.filter(c => existsSync(c.wavPath));
    if (!clips.length) {
      p.onCompleted?.(false);
      return;
    }
    const completions: Promise<boolean>[] = [];
    let sfxHanded = false;
    for (const clip of clips) {
      try {
        // Deferred segments ride the INTRO file (light duck at a track
        // boundary), whatever their kind — see announceAtNextTrack. An exchange
        // line still carries its SPEAKER's attribution (exchangeSegment), which
        // is what session.windowMessages() and prompt-memory key off; only the
        // channel changes, because the channel is a fact about the boundary and
        // not about the line.
        const seg: SegmentDesc = p.exchange
          ? {
              ...exchangeSegment(clip, p.kind),
              channel: 'intro',
              settlesHandoff: clip.settlesHandoff,
            }
          : { kind: p.kind, channel: 'intro', text: clip.text, meta: clip.meta, persona: clip.persona };
        const handoff = await airVoice(config.liquidsoap.introFile, clip.wavPath, clip.text, voiceGainDb(p.kind, clip.persona), {
          onQueued: q => this.onQueued(q, seg),
        });
        completions.push(this.onSpoken(handoff, seg));
        if (!sfxHanded && p.sfx) {
          sfxHanded = true;
          await this.playSfx(p.sfx, { underVoice: true });
        }
      } catch (err) {
        this.log('error', `Air pending voice failed: ${(err as Error).message}`);
      }
    }
    void Promise.all(completions).then(results => p.onCompleted?.(results.some(Boolean)));
    // One webhook for the whole exchange, at air time — the same single event
    // announceExchange fires, moved to where the words actually reached the
    // stream. A single-clip segment's event rides onSpoken like every other.
    if (p.exchange) {
      webhooks.notify('dj.say', {
        text: clips.map(c => `${c.persona?.name || 'DJ'}: ${c.text}`).join('\n'),
        kind: p.kind,
      });
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
    const liveSessionKey = session.getSession()?.key ?? null;
    if (shouldDropCrossSessionLink(item, liveSessionKey)) {
      item.introAired = true;
      this.log('link-skip', `Dropped link speech before "${item.track?.title}" — it belongs to ${item.introSessionKey}, not the live ${liveSessionKey}`);
      this.persist();
      return;
    }
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
        // Attribute the turn so windowMessages() can name the real speaker.
        // A cross-session DJ link was vetoed above; request intros may still
        // carry a deliberately pinned persona.
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
    // The rotate's own clock (#1619). Only real MUSIC boundaries reach here —
    // a bed branches before now-playing.json's title gate and a jingle is
    // captured outside music_meta entirely — so this counts the same thing
    // radio.liq's `rotate(weights=[1, jingle_ratio()])` counted, and the
    // controller can draw the stinger the mixer used to draw itself.
    this._tracksSinceJingle++;

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
          // For the album cooldown (#1485 FR 3). The compilation flags are NOT
          // carried: albumKey exempts on the CANDIDATE side, which is the side
          // holding them (a library row carries both; a Subsonic-sourced play
          // often carries neither), and a block needs both sides to key alike.
          album: t.album || null,
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
      // Air this track's intro now it is on air (#189). Fire-and-forget: the
      // writeHandoff can block for maxWaitMs and must not stall the watcher
      // tick. Uses the live `this.current` so introAired lands on the tracked
      // object, and passes the REAL predecessor for the stale-link drop.
      const introQueued = this.airIntro(this.current, this.history[0]?.track || null);
      // Pair-drain may have armed this handoff while the preceding track was on
      // air. Confirmed playback of the recorded final track is the permission to
      // speak; queue its own intro first, then let the handoff take the voice
      // chain behind it.
      void introQueued
        .catch(err => this.log('error', `Final-track intro failed: ${(err as Error).message}`))
        .then(() => this.runArmedBoundaryHandoff());
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
      // Carried so backfillRecentPlaysFromEvents can rebuild album keys after a
      // restart. Without it the album cooldown forgets everything the sidecar
      // didn't hold, which on a fresh boot is most of the window.
      album: this.current.track.album || null,
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

  async runArmedBoundaryHandoff({
    getContext = getFullContext,
    preparePlan = programme.prepareBoundaryPlan,
    runHandoff = (ctx: session.SessionContext) => djAgent.runPersonaHandoff(this, ctx),
  }: {
    getContext?: typeof getFullContext;
    preparePlan?: typeof programme.prepareBoundaryPlan;
    runHandoff?: (ctx: session.SessionContext) => Promise<void>;
  } = {}) {
    const track = this.current?.track ?? null;
    if (!session.boundaryHandoffReadyForTrack(track)) return;
    const contextAt = session.boundaryHandoffContextAt();
    if (!contextAt) return;
    try {
      const ctx = await getContext(contextAt);
      await preparePlan(ctx);
      if (talkOnlyBetweenTracks()) {
        await withTalkAir('next-track', () => runHandoff(ctx));
      } else {
        await runHandoff(ctx);
      }
    } catch (err) {
      this.log('error', `Boundary handoff failed: ${(err as Error).message}`);
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
        // The pick made now airs when the track it FOLLOWS ends, so near a show
        // boundary the rules to pick by are the NEXT show's. PICK_SHOW_LOOKAHEAD
        // probes a little past the expected start so a pick beginning just shy
        // of the boundary — and playing mostly inside the new show — counts as
        // the new show's.
        //
        // The lead is what REMAINS of the on-air track, never its full duration:
        // this cycle also runs from the deadline backstop and from boot
        // recovery, part-way through a track, where the elapsed part would push
        // `showAt` over the next boundary early (#1205). With a held pick anchor
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
          pickAnchorItem ? knownDurationSec(pickAnchorItem.track) : null,
        );
        let showAt: Date | null = null;
        if (leadSec != null) {
          showAt = new Date(Date.now() + (leadSec + PICK_SHOW_LOOKAHEAD_SEC) * 1000);
        }
        const pickCtx = await getFullContext(showAt ?? undefined);
        const liveCtx = await getFullContext();
        await session.maybeRoll(liveCtx);
        // Keep the live session and roster outgoing until the actual boundary.
        // The look-ahead context is only for selecting the track that follows.
        const finalTrackHandoff = session.armBoundaryHandoff(
          pickCtx,
          pickAnchorItem?.track ?? this.current?.track ?? null,
        );
        if (finalTrackHandoff) {
          try {
            await programme.prepareBoundaryPlan(pickCtx);
          } catch (err) {
            this.log('error', `Incoming programme plan failed: ${(err as Error).message}`);
          }
        }
        // Plan a programme episode BEFORE the mic-pass so a handoff into a
        // programme show can weave the episode angle into its greeting.
        try {
          await programme.ensurePlan(liveCtx);
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
          // A deadline pick runs while the track BEFORE pickAnchorItem is still
          // live. It may prepare the handoff, but confirmed playback of that
          // recorded final track is what lets runArmedBoundaryHandoff speak.
          const pendingMicPass = !!session.pendingHandoff();
          if (pendingMicPass
              && !session.boundaryHandoffAwaitsTrack()
              && !(finalTrackHandoff && pickAnchorItem)) {
            this.dropPendingVoice('the show handoff covers this boundary');
            const handoffCtx = finalTrackHandoff ? pickCtx : liveCtx;
            if (finalTrackHandoff && talkOnlyBetweenTracks()) {
              // Render now, then the queue releases the complete pair at the
              // first real seam at/after the scheduled boundary.
              await withTalkAir('next-track', () => djAgent.runPersonaHandoff(this, handoffCtx));
            } else {
              await djAgent.runPersonaHandoff(this, handoffCtx);
            }
          }
        } catch (err) {
          this.log('error', `Persona handoff failed: ${(err as Error).message}`);
        }
        // Programme shows: open the episode if the hourly cron hasn't
        // already (whichever call site settles the session first wins; the
        // beat flag makes the other a no-op).
        try {
          // `opportunity: true` — this IS a drain/boundary cycle, so a standalone
          // intro held here has genuinely passed one up (#1576).
          await programme.onSessionSettled(this, liveCtx, undefined, { opportunity: true });
        } catch (err) {
          this.log('error', `Programme episode hook failed: ${(err as Error).message}`);
        }
        await djAgent.runTrackEvent(this, pickCtx, {
          // The mic-pass owns this seam; an outgoing link cannot follow it.
          wantLink: wantLink && !finalTrackHandoff,
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
    this.runPickCycle({ isAutonomous: !head.requestedBy, pickAnchorItem: head });
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
  // IT COUNTS HIDDEN TIMELINE ITEMS, and any future walk of this queue must too.
  // Beds and pause silences are written straight to `next.txt` and are never
  // `upcoming` entries, so a clock that walks the queue sails straight past
  // them — the #1574 failure put the show-boundary cut a whole link late.
  // `hiddenDelayBeforeItemAirs` is that measurement and is reused rather than
  // re-walked: it sums this item's OWN hidden delay plus the delays of SENT
  // items ahead. An UNSENT item ahead legitimately contributes zero — its
  // hidden item is decided at ITS drain and has not been pushed yet — so the
  // two walks agree by construction.
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
    return remaining + this.hiddenDelayBeforeItemAirs(item);
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
  // Sole consumer is the agent path's pick-anchor/spacing artist guard (#1251), whose
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

  // The ALBUM keys (music/recency.albumKey — album + lead album artist, with
  // compilations keyed as '' and therefore exempt) heard inside `hours`, plus
  // every album already queued and unaired, plus the one on air.
  //
  // ONE method for BOTH pick paths (#1485 FR 3): the pool picker passes it to
  // filterPickerCandidates and the agent path's album guard tests its pick
  // against it, so "which albums are too recent" cannot mean two things. That
  // is the property the artist guard does NOT have — recentArtistsSince (hours,
  // pool) and neighbourArtistRoots (slots, agent) answer deliberately different
  // questions — and it is why this one is in hours: an hours window is the
  // shape both paths can read without either of them re-deriving it.
  //
  // The QUEUED side is included for the reason neighbourArtistRoots documents:
  // a pick is not always adjacent to the track on air, so with a pair-aware
  // drain (or a request stacked ahead) an album queued two slots out is exactly
  // the repeat this guard exists to catch, and it has no play row yet. Unlike
  // that method this takes the WHOLE queue rather than a tail — everything in
  // it will air inside any window worth setting.
  //
  // Empty set when hours <= 0, which is the shipped default: the cooldown is
  // off until an operator asks for it, so an upgrade changes nothing.
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

  // The silent item has reached the music timeline. Release its held speech on
  // the regular say queue, not on dj_queue: this is the point of the design.
  // The pause id prevents an old marker surviving a controller restart from
  // claiming a newer held segment.
  onPauseTalkStarted() {
    const p = this._pendingVoice;
    if (!p?.pauseTalk || !p.pauseId || p.pauseReleasing) return;
    let marker: { pauseId?: string; startedAt?: number };
    try {
      marker = JSON.parse(readFileSync(config.liquidsoap.pauseTalkPlayingFile, 'utf8'));
    } catch {
      return;
    }
    if (marker.pauseId !== p.pauseId) return;
    const startedMs = Number(marker.startedAt) * 1000;
    const markerAgeMs = Date.now() - startedMs;
    // A matching pause id plus its durable commitment makes this stronger than
    // the reusable bed marker. Accept it for the silence's own lifetime so a
    // controller restart during the break can still recover the voice.
    const markerWindowMs = p.pauseSilenceMs && p.pauseSilenceMs > 0
      ? p.pauseSilenceMs + PAUSE_TALK_MARKER_POLL_MS
      : BED_MARKER_FRESH_MS;
    if (!Number.isFinite(startedMs) || markerAgeMs < 0 || markerAgeMs > markerWindowMs) return;
    p.pauseReleasing = true;
    const clips = p.clips.filter(c => existsSync(c.wavPath));
    if (!clips.length) {
      this._pendingVoice = null;
      p.onCompleted?.(false);
      void discardPauseTalkCommit();
      return;
    }
    // Wait out the predecessor's crossfade before opening the mic. radio.liq's
    // `cross` sizes a transition from the OUTGOING track's stamp, so the song
    // that just ended is still fading over the head of this silence — speaking
    // into it would put the segment under decaying music, which is the ducking
    // the break exists to replace. Measured from the silence's own start, so
    // the poll latency already spent is credited rather than paid twice, and
    // budgeted into the silence by silenceDurationMs.
    const delay = releaseDelayMs({
      incomingCrossMs: p.pauseIncomingCrossMs ?? 0,
      elapsedSinceStartMs: Date.now() - startedMs,
    });
    this.log('scheduler',
      `Pause-and-talk break on air → speaking ${p.kind}${delay ? ` after ${Math.round(delay / 1000)}s of crossfade tail` : ''}`);
    void (async () => {
      if (delay) await new Promise(r => setTimeout(r, delay));
      const clip = clips[0]!;
      const deliveryId = p.pauseId!;
      const seg: SegmentDesc = {
        kind: p.kind,
        channel: 'say',
        text: clip.text,
        meta: clip.meta,
        persona: clip.persona,
      };
      const waitMs = Math.max(1_000,
        (p.pauseArmedAt ?? Date.now()) + PAUSE_TALK_ARM_MAX_AGE_MS - Date.now());
      let observed = inspectPauseVoiceDelivery(deliveryId);
      try {
        // On a controller restart, `unpublished` can be the few milliseconds
        // after poll_voice removed say.txt and before it atomically wrote the
        // accepted marker. Let the still-running mixer resolve that ambiguity
        // before publishing the stable id. The first pause mixer has no
        // accepted marker, but its generic voice-playing marker is recognised.
        if (p.pauseRecovered && observed.phase === 'unpublished') {
          observed = await waitForPauseVoiceClaim(
            deliveryId,
            PAUSE_TALK_RECOVERY_AMBIGUITY_MS,
          );
        }

        const started = observed.phase === 'started'
          ? Promise.resolve(observed.startedAt)
          : waitForPauseVoiceStarted(deliveryId, waitMs);
        let handoff: VoiceHandoff;
        if (observed.phase === 'published' || observed.phase === 'accepted' || observed.phase === 'started') {
          handoff = {
            voiceId: deliveryId,
            clipMs: clipDurationMs(clip.wavPath, clip.text),
            aired: started,
          };
          this.log('scheduler', `Pause-and-talk ${p.kind} recovery observed voice ${observed.phase} — not republishing ${deliveryId}`);
        } else {
          handoff = await airVoice(
            config.liquidsoap.sayFile,
            clip.wavPath,
            clip.text,
            voiceGainDb(p.kind, clip.persona),
            {
              voiceId: deliveryId,
              pauseDeliveryId: deliveryId,
              airMarkerPromise: started,
              onQueued: q => this.onQueued(q, seg),
            },
          );
          if (p.sfx) {
            await this.playSfx(p.sfx, { underVoice: true });
            p.sfx = null;
          }
        }

        const airedAt = await handoff.aired;
        if (airedAt == null) {
          // Once a stable id was published or accepted, retrying is the one
          // action that can make it play twice. Give up ownership without a
          // second handoff; a healthy mixer always supplies the start marker.
          this.log('error', `Pause-and-talk voice ${deliveryId} did not produce a start acknowledgement — not republishing`);
          if (this._pendingVoice === p) this._pendingVoice = null;
          await discardPauseTalkCommit();
          p.onCompleted?.(false);
          return;
        }

        const completed = await this.onSpoken(handoff, seg);
        // The controller's durable acknowledgement comes AFTER the mixer's
        // start marker and ordinary post-air bookkeeping. If deletion is
        // interrupted, recoverPauseTalk sees this phase and only cleans up.
        p.pauseAcknowledgedAt = Date.now();
        await writePauseTalkCommit(p);
        if (this._pendingVoice === p) this._pendingVoice = null;
        await discardPauseTalkCommit();
        p.onCompleted?.(completed);
      } catch (err) {
        this.log('error', `Pause-and-talk voice failed: ${(err as Error).message}`);
        if (this._pendingVoice !== p) return;
        const after = inspectPauseVoiceDelivery(deliveryId);
        if (after.phase === 'unpublished') {
          p.pauseReleasing = false;
          this.disarmPauseTalk(p, 'its voice handoff failed before publication');
        } else {
          // Published/accepted is irrevocable: fallback would be a second copy.
          this._pendingVoice = null;
          await discardPauseTalkCommit();
          p.onCompleted?.(false);
        }
      }
    })();
  }

  // Poll now-playing.json every 1.5s and dispatch track changes. Each tick also
  // refreshes the in-memory copy getNowPlaying() serves, so the per-listener
  // /now-playing poll never has to touch the disk.
  startWatcher() {
    const tick = async () => {
      this._nowPlaying = await this.readNowPlayingFromDisk();
      this._nowPlayingFresh = true;
      this.onTrackStarted(this._nowPlaying);
      // Beds ride the same tick rather than a poller of their own — a bed's
      // start is a track-boundary event like any other, and the 1.5s cadence is
      // already inside the head budget bed-policy sizes the bed with.
      this.onBedStarted();
      this.onPauseTalkStarted();
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
