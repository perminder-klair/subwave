// Queue manager — keeps the in-memory queue and writes track URIs
// to the file Liquidsoap watches. A now-playing watcher rotates items
// between upcoming → current → history based on what Liquidsoap reports.

import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { config } from '../config.js';
import { writeFileAtomic } from '../util/atomic-file.js';
import * as subsonic from '../music/subsonic.js';
import * as mix from '../music/mix.js';
import * as library from '../music/library.js';
import * as blocklist from '../music/blocklist.js';
import { analyzeOnPick, analyzeOnPickEnabled } from '../music/analyze.js';
import { speak, voiceGainDb } from '../audio/tts.js';
import * as djAgent from './dj-agent.js';
import * as programme from './programme.js';
import * as sfx from './sfx.js';
import * as session from './session.js';
import type { TurnMeta } from './session.js';
import { getFullContext, energyForDaypart } from '../context.js';
import * as settings from '../settings.js';
import { logEvent } from '../observability/events.js';
import { djCallsAllowed, presentListeners } from './listeners.js';
import * as webhooks from './webhooks.js';
import * as scrobble from './scrobble.js';
import * as liquidsoapControl from './liquidsoap-control.js';
import type { TrackOutro, TrackKeyRange } from '../music/library-db.js';

// A persona as it flows through the queue's voice path — only `id`/`name`/
// `djMode` are read here; the rest rides through to tts.speak()/voiceGainDb().
interface Persona {
  id?: string;
  name?: string;
  djMode?: boolean;
  [k: string]: unknown;
}

// A playable track. A loose bag by design: picks arrive from the LLM agent and
// from Subsonic carrying different subsets, and applyMixTransition arms/strips
// the transition-effect flags in place. Every field is optional so a partial
// pick and a fully-analysed one share one type.
interface Track {
  id?: string | null;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  year?: number | null;
  duration?: number | null;
  bpm?: number | null;
  musicalKey?: string | null;
  loudnessLufs?: number | null;
  peakDb?: number | null;
  // OpenSubsonic ReplayGain block riding the raw Navidrome song object —
  // subsonic.ts returns API children unmodified, so tagged files carry it
  // into the queue for free. applyLoudnessGain prefers it over the measured
  // LUFS when settings.loudness.source allows (issue #998).
  replayGain?: { trackGain?: number | null; trackPeak?: number | null } | null;
  introMs?: number | null;
  keyRanges?: TrackKeyRange[] | null;
  outro?: TrackOutro | null;
  gainDb?: number;
  // Transition-effect flags + their stamped parameters (armed/stripped by
  // applyMixTransition, consumed by subsonic.getAnnotatedUri and radio.liq).
  sweep?: boolean;
  washout?: boolean;
  washoutAuto?: boolean;
  washoutDelay?: number;
  blend?: boolean;
  dissolve?: boolean;
  chop?: boolean;
  chopPeriod?: number;
  loop?: boolean;
  loopBar?: number;
  crossSec?: number;
  [k: string]: unknown;
}

// One entry in the queue. `upcoming` holds these before play; `current` and
// `history` are the same shape with the runtime-stamped startedAt/endedAt/
// source added.
interface QueueItem {
  track: Track;
  requestedBy?: string | null;
  intent?: string | null;
  introScript?: string | null;
  introKind?: string;
  aiPicked?: boolean;
  linkPrev?: { id: string | null; title: string | null; artist: string | null } | null;
  introWav?: string | null;
  introAired?: boolean;
  queuedAt?: string;
  sent?: boolean;
  confirmedInLiquidsoap?: boolean;
  transitionSfx?: string;
  startedAt?: string;
  endedAt?: string;
  source?: string;
}

// One row in the rolling recent-plays sidecar (the picker's repeat window).
interface RecentPlay {
  id: string | null;
  title: string | null;
  artist: string | null;
  endedAt: string;
}

// A controller-level log line surfaced to the web UI + the DJ recap.
interface DjLogEntry {
  id: number;
  kind: string;
  message: string;
  meta: Record<string, unknown>;
  t: string;
}

// now-playing.json as Liquidsoap writes it.
interface NowPlaying {
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  subsonic_id?: string | null;
  [k: string]: unknown;
}

// Random gap between DJ links on auto-played tracks. The frequency setting
// scales how chatty the DJ is:
//   silent     → Infinity (a link is never due; the countdown never reaches 0)
//   quiet      → uniform 8-20 tracks between links
//   moderate   → current behaviour (1-9 85% of the time, 10-15 the other 15%)
//   chatty     → uniform 1-5 tracks
//   aggressive → uniform 1-3 tracks
// A DJ-mode persona reads one rung chattier (effectiveFrequency), so it links
// transitions far more often — a working DJ talks across most of them.
function pickLinkInterval() {
  const f = settings.effectiveFrequency();
  if (f === 'silent')     return Infinity;
  if (f === 'quiet')      return 8 + Math.floor(Math.random() * 13);
  if (f === 'chatty')     return 1 + Math.floor(Math.random() * 5);
  if (f === 'aggressive') return 1 + Math.floor(Math.random() * 3);
  if (Math.random() < 0.15) return 10 + Math.floor(Math.random() * 6);
  return 1 + Math.floor(Math.random() * 9);
}

// How many consecutive reconcile checks may report an EMPTY dj_queue (while the
// controller still holds sent items) before we treat those items as genuinely
// gone and clear them. A single empty read is ambiguous — a just-sent pick may
// be mid-poll, or Liquidsoap may have restarted and lost the queue — so we never
// drop on one read. Unlike the old `_autoMisses` heuristic (which advanced on
// benign metadata mismatches while the tracks were still in dj_queue, wrongly
// wiping live queues — #632), this only advances when Liquidsoap AUTHORITATIVELY
// reports no pending requests, so an interleaved jingle or artist-string variance
// can't trip it.
const EMPTY_DJ_QUEUE_CLEAR_THRESHOLD = 3;

// Upper bound on how far a recordPlay end-stamp can sit after the play's start
// for the events-backfill dedup (playAlreadyRecorded). recordPlay stamps
// endedAt at the track's END; an event's `t` is its START, so the two differ by
// the track length. 15 min comfortably covers normal tracks (a track longer
// than this is rare and only costs one harmless duplicate sidecar row), while
// staying short enough that a genuine replay — always spaced more than a track
// length apart — keeps its own entry rather than being merged away.
export const BACKFILL_DEDUP_MAX_GAP_MS = 15 * 60_000;

// How far PAST the next pick's expected start the show-boundary look-ahead
// probes (see onTrackStarted). The pick's start time alone under-corrects: a
// track starting 30s before a boundary plays almost entirely inside the new
// show but would still resolve the old one. Two minutes ≈ the midpoint of a
// typical track, so whichever show owns most of the pick's airtime wins. The
// symmetric cost — an on-format-for-the-NEXT-show track starting a minute or
// two early — is how real radio tees up a changeover anyway.
const PICK_SHOW_LOOKAHEAD_SEC = 120;

// Has this events-log play already been recorded by recordPlay? The old dedup
// keyed on `${endedAt}|${title}` — an EXACT timestamp match — but recordPlay's
// end-stamp never equals the event's start `t`, so it never fired and every
// play got a duplicate id-less copy, filling the 300-entry sidecar in ~5h
// instead of ~12h (halving the real anti-repeat window). Match on title|artist
// with an existing endedAt landing in [t, t + maxGapMs] instead: exactly the
// window a recordPlay end-stamp falls in for the SAME play. Pure + exported so
// the dedup logic is unit-pinned (scripts/recent-plays.test.ts) without disk.
export function playAlreadyRecorded(
  existing: { title: string | null; artist: string | null; endedAt: string }[],
  ev: { title?: string | null; artist?: string | null; t: string },
  maxGapMs: number,
): boolean {
  const keyOf = (title: string | null | undefined, artist: string | null | undefined) =>
    `${(title || '').toLowerCase().trim()}|${(artist || '').toLowerCase().trim()}`;
  const k = keyOf(ev.title, ev.artist);
  const t = new Date(ev.t).getTime();
  if (!Number.isFinite(t)) return false;
  for (const p of existing) {
    if (keyOf(p.title, p.artist) !== k) continue;
    const at = new Date(p.endedAt).getTime();
    if (Number.isFinite(at) && at >= t && at - t <= maxGapMs) return true;
  }
  return false;
}

class Queue {
  upcoming: QueueItem[] = [];  // request items pushed by listeners, not yet playing
  current: QueueItem | null = null;    // what's broadcasting right now (request or auto)
  history: QueueItem[] = [];   // finished tracks, newest first
  djLog: DjLogEntry[] = [];    // controller-level events for the web UI
  lastSeenKey: string | null = null;   // for change detection in the watcher
  _nowPlaying: NowPlaying | null = null;   // last parse of now-playing.json, refreshed by the watcher
  _nowPlayingFresh = false;            // true once the watcher's first tick has landed
  senderBusy = false;          // drain-to-Liquidsoap mutex
  pickerBusy = false;          // prevent concurrent LLM picks
  autoPick = true;             // toggle: should we ask Ollama for next track when idle
  autoLink = true;             // toggle: random DJ links between auto tracks
  tracksUntilLink = pickLinkInterval();
  _transitionsSinceSfx = 999;  // DJ-mode transition-FX spacing counter (see drainToLiquidsoap)
  _recentEffects: string[] = [];  // the model's last few transition CHOICES — anti-streak guard + fed back into the pick event turn
  _persistTimer: NodeJS.Timeout | null = null; // debounce for the queue.json snapshot
  _recentPlaysTimer: NodeJS.Timeout | null = null; // debounce for the recent-plays.json sidecar
  _recentPlays: RecentPlay[] = [];
  _emptyDjQueueStreak = 0;      // consecutive reconcile checks seeing an empty dj_queue while sent items remain — see reconcileWithDjQueue
  _pendingVoice: { text: string; kind: string; wavPath: string; persona: Persona | null; meta: TurnMeta; t: number } | null = null; // one boundary-deferred segment awaiting the next track start — see announceAtNextTrack

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
          // Drop anything older than 48h on boot — keeps the file from
          // ballooning if the cap was raised between restarts.
          const cutoff = Date.now() - 48 * 3_600_000;
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
  getDjRecap({ limit = 10, withinMinutes = 120, maxChars = 140 } = {}) {
    const cutoff = Date.now() - withinMinutes * 60_000;
    const seenDedupe = new Set<string>();
    const picked: DjLogEntry[] = [];
    for (const entry of this.djLog) {
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
  getRecentOpeners(n = 6) {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const entry of this.djLog) {
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

  // Push a listener request. Adds to upcoming and kicks off the Liquidsoap sender.
  // `introScript` is the spoken intro/link tied to THIS track — it is NOT aired
  // at queue time. drainToLiquidsoap renders it to a WAV ahead of time and
  // airIntro() writes that WAV to Liquidsoap only when the track actually starts
  // playing (see onTrackStarted), so the voice always lands over the right song.
  // `introKind` picks both the TTS engine routing and the duck channel:
  //   'dj-speak' → say.txt   (HEAVY duck — request intros)
  //   'link'     → intro.txt (LIGHT duck — between-track auto-DJ links)
  // `linkPrev` is the track this item's intro/link BACK-ANNOUNCES (the one that
  // was on-air when the pick was made). A between-track link is written as "that
  // was X, here's this" against the track playing then; deferring it to air time
  // (#189) is only valid while this pick is still the immediately-next track. If
  // a listener request slips into `upcoming` ahead of it before it airs, that
  // request plays first, so the baked-in "that was X" would name a track one (or
  // more) older than what actually just played. airIntro() uses linkPrev to
  // detect that and drop the now-stale back-announce rather than air a wrong
  // name. Left null for request intros (they never back-announce).
  async push({ track, requestedBy = null, intent = null, introScript = null, introKind = 'dj-speak', aiPicked = false, allowDuplicate = false, linkPrev = null }: {
    track: Track;
    requestedBy?: string | null;
    intent?: string | null;
    introScript?: string | null;
    introKind?: string;
    aiPicked?: boolean;
    allowDuplicate?: boolean;
    linkPrev?: { id?: string | null; title?: string | null; artist?: string | null } | null;
  }) {
    // Dedup guard. Applies to AI picks AND listener requests: two listener
    // requests resolving to the same song over the 25-45s identify/match window
    // each read queuedIds() before either reaches push(), so the early read
    // can't see the other (issue #619). This check is the only synchronous
    // point where both are visible — there is no await between it and the
    // upcoming.push() below, so within the single-threaded event loop it's
    // atomic and closes the race. Returns -1 so the caller can acknowledge
    // honestly ("already on the way") instead of queuing a second back-to-back
    // play. `allowDuplicate` opts an explicit operator action (the studio
    // queue-track route) out — a deliberate manual queue always fires.
    // Global never-play gate — the blocklist is absolute (operator's call:
    // even explicit manual queueing is refused until the entry is unblocked),
    // so it sits above allowDuplicate. Every playback path funnels through
    // push() (dj-agent, requests, MCP, studio queue), making this the last
    // line even for sources that bypass the subsonic/library filters.
    if (blocklist.isBlocked(track)) {
      this.log('blocked', `${track?.title} — ${track?.artist} (on the never-play blocklist, refused)`);
      return -2;
    }
    if (!allowDuplicate && track?.id) {
      const dominated = this.upcoming.some(i => i.track?.id === track.id)
        || (this.current?.track?.id === track.id);
      if (dominated) {
        this.log('dedup-skip', `${track.title} -- ${track.artist} (already queued)`);
        return -1;
      }
    }
    const item = {
      track, requestedBy, intent, introScript, introKind, aiPicked,
      // Only stamp a back-announce target when there's actually an intro/link to
      // air against it; a bare track carries no claim about what preceded it.
      linkPrev: (introScript && linkPrev)
        ? { id: linkPrev.id ?? null, title: linkPrev.title ?? null, artist: linkPrev.artist ?? null }
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
  // entry is added. Only undrained items (`!sent`) are removable; anything
  // already handed to Liquidsoap plays out (we never interrupt), and the
  // currently playing track is likewise left alone. Returns how many dropped.
  purgeBlocked(): number {
    const keep = this.upcoming.filter(i => i.sent || !blocklist.isBlocked(i.track));
    const dropped = this.upcoming.length - keep.length;
    if (dropped > 0) {
      this.upcoming = keep;
      this.log('blocked', `purged ${dropped} upcoming track${dropped === 1 ? '' : 's'} now on the never-play blocklist`);
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
    };
  }

  // Resolve a track's integrated loudness + peak and stash a clamped gain
  // offset toward the operator's loudness target on the track as `gainDb`.
  // Source ladder is settings.loudness.source: an embedded ReplayGain tag
  // (whole-file stereo R128 via Navidrome, issue #998) outranks the analyzer's
  // measured LUFS (leading-window only) unless the operator pins one source.
  // A track object without the `replayGain` key came through a projection
  // that dropped it (the agent's slim candidates, a JSON round trip), so a
  // one-row getSong recovers it — `replayGain: {}`/null means Navidrome was
  // asked and the file is untagged, no lookup. Measured values resolve track
  // object first, else a library lookup. The peak lets gainForLoudness cap
  // the boost by real headroom instead of a blind clamp; a ReplayGain
  // loudness keeps its own trackPeak (mixing it with the analyzer's window
  // peak would cap against a different scan). Null loudness from every
  // allowed source → leaves gainDb undefined, so getAnnotatedUri emits no
  // liq_amplify and the track plays at unity gain.
  async applyLoudnessGain(track: Track | null) {
    if (!track) return;
    const loud = settings.get().loudness;
    const source = loud?.source ?? 'replaygain-then-measured';
    let lufs: number | null | undefined = null;
    let peakDb: number | null | undefined = null;
    if (source !== 'measured') {
      let rg = mix.loudnessFromReplayGain(track.replayGain);
      if (!rg && track.replayGain === undefined && track.id) {
        try {
          const song = await subsonic.getSong(track.id);
          track.replayGain = song?.replayGain ?? null; // cache the answer either way
          rg = mix.loudnessFromReplayGain(song?.replayGain);
        } catch (err) {
          // Best-effort — an unreachable Navidrome falls through to measured.
          this.log('warn', `replayGain lookup failed for ${track.id}: ${(err as Error).message}`);
        }
      }
      if (rg) {
        lufs = rg.lufs;
        peakDb = rg.peakDb;
      }
    }
    if (lufs == null && source !== 'replaygain') {
      lufs = track.loudnessLufs;
      peakDb = track.peakDb;
      if ((lufs == null || peakDb == null) && track.id) {
        const rec = library.get(track.id);
        if (lufs == null) lufs = rec?.loudnessLufs ?? null;
        if (peakDb == null) peakDb = rec?.peakDb ?? null;
      }
    }
    const gain = mix.gainForLoudness(lufs, {
      peakDb,
      targetLufs: loud?.targetLufs,
      maxBoostDb: loud?.maxBoostDb,
    });
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

  // DJ-mode mixing applied to the transition INTO `item`'s track (features 1 &
  // 2, plus the sweep/washout transition effects). No-op unless the active
  // persona is in DJ mode. Stashes a per-transition crossfade length on the
  // track (read by subsonic.getAnnotatedUri → liq_cross_duration) and, on a
  // notable upward tempo jump, fires a rate-limited riser across the blend.
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

    // Feature 1 — adaptive blend length, with a subtle daypart nudge and a
    // structure-aware cap so the incoming fade-in finishes before the song's
    // vocals (the incoming track's instrumental intro, resolved like analysis).
    let energyDelta = 0;
    try { energyDelta = energyForDaypart().speed - 1; } catch {}
    let nextIntroMs = item.track.introMs;
    if (nextIntroMs == null && item.track.id) nextIntroMs = library.get(item.track.id)?.introMs ?? null;
    // Cap the adaptive blend at the operator's configured crossfade length so the
    // admin slider acts as a real ceiling on DJ-mode transitions too.
    const maxSec = settings.get()?.crossfadeDuration ?? null;
    const secs = mix.crossSecondsFor(cur, next, { energyDelta, nextIntroMs, maxSec });
    // NOT stamped onto item.track.crossSec (#749 — off-by-one, confirmed still
    // live on inspection despite the issue being closed with no fix commit).
    // liq_cross_duration governs the crossfade at the STAMPED track's OWN end
    // (radio.liq's dj_transition reads it off `a`, the outgoing branch) — but
    // `secs` here is sized for the transition INTO item (prevTrack → item).
    // The only track that could correctly carry this value is prevTrack, and
    // drainToLiquidsoap drains strictly FIFO, marking each item sent before
    // the next is even looked at — so prevTrack has invariably already been
    // annotated and handed to Liquidsoap by the time this runs. Stamping it
    // on item instead silently governs item's OWN exit (item → next), sized
    // by the wrong pair's compatibility and intro cap, one hop later than
    // intended — and that error compounds every transition for the rest of
    // the session. Left un-applied (logged only) until there's a real fix: a
    // buffer-time override channel Liquidsoap re-reads dynamically, not a
    // static per-track annotation baked in ahead of the pair being known.
    if (secs != null) {
      this.log('mix', `blend would be ${secs}s for ${prevTrack.title || '?'} → ${item.track.title} (not applied — #749)`);
    }

    // DJ transition effects (sweep/washout) — the agent proposes, the data
    // disposes. A rejected flag is stripped so getAnnotatedUri never stamps it. On success the
    // washout also gets its canvas + tempo stamps: cross-duration physics puts
    // both on the flagged track itself (its liq_cross_duration governs its OWN
    // end, exactly where the wash fires — overriding the feature-1 value). The
    // sweep needs no stamps: the transition INTO it is already sized, and its
    // envelope scales to whatever d it gets.
    // Length-cap exit (max-track-length × effects): when this pick will be CUT
    // by the cap (duration > effectiveMaxTrackSec → drain stamps liq_cue_out),
    // its ending is a forced mid-song exit — and the classic DJ move for
    // leaving a record before it ends is the echo-out. Auto-arm a washout so
    // the cut sounds intentional instead of broken. Deterministic, not an LLM
    // choice: the controller KNOWS which tracks will be capped. The flag rides
    // the ending track, exactly like a DJ-chosen washout, and coexists with a
    // sweep on the same pick (sweep shapes its ENTRY, washout its EXIT).
    // Requests are exempt from the cap (requestedBy) so they never arm this.
    const capSec = item.requestedBy ? null : settings.effectiveMaxTrackSec();
    let durSec = Number(item.track.duration) || 0;
    // Same resolution ladder as loudness/analysis: the track object first
    // (Subsonic picks carry it), the library row when it doesn't (agent picks
    // resolve from the picker tools' slim projections, which omit length when
    // the source tool didn't surface one).
    if (!durSec && item.track.id) durSec = Number(library.get(item.track.id)?.durationSec) || 0;
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
        const windDownSec = durSec > 0 && Number.isFinite(outro.startMs)
          ? Math.max(0, durSec - outro.startMs / 1000)
          : null;
        // Body loudness for the tail-drop shaping — same resolution ladder as
        // applyLoudnessGain (track object first, else the library row).
        let bodyLufs = item.track.loudnessLufs;
        if (bodyLufs == null && item.track.id) bodyLufs = library.get(item.track.id)?.loudnessLufs ?? null;
        // Bar-snap to the TAIL tempo when measured — outros drift/ritard.
        const exitSecs = mix.endingCrossSecondsFor(
          { bpm: outro.bpm ?? next.bpm, key: next.key, ending: outro.ending },
          windDownSec,
          { maxSec, tailLufs: outro.lufs ?? null, bodyLufs },
        );
        if (exitSecs != null) {
          item.track.crossSec = exitSecs;
          this.log('mix', `exit canvas ${exitSecs}s (${outro.ending} ending) → ${item.track.title}`);
        }
      }
    }

    // The two flags are independent boundaries — sweep shapes this pick's
    // ENTRY, washout its EXIT — so both can ride one pick; validate and stamp
    // them separately. No cooldown by design: pacing is the DJ's call (the
    // prompt tells it to let ordinary blends breathe between effects); the
    // analyzer veto is the only deterministic guard, and it only judges
    // sweeps (musically wrong between locked tracks), never frequency.
    // Anti-streak: the model imitates its own session history, so once it
    // finds a defensible favourite it repeats it mechanically (observed twice:
    // all-normal, then all-blend). The third consecutive IDENTICAL CHOICE is
    // stripped — variety is a station rule, not a model virtue. The ledger
    // tracks what the model ASKED FOR, not what aired: a stripped blend still
    // evidences monoculture, so a stuck model gets everything past the second
    // stripped until it genuinely varies. Auto (length-cap) washouts are
    // deterministic, not choices — invisible to the ledger in both directions.
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

  // Walk the upcoming queue and feed unsent items to Liquidsoap one at a time,
  // spaced out so the 1s file-poll doesn't miss any.
  async drainToLiquidsoap() {
    if (this.senderBusy) return;
    this.senderBusy = true;
    try {
      while (true) {
        const item = this.upcoming.find(i => !i.sent);
        if (!item) break;

        // Render the track's intro/link WAV ahead of time but DON'T air it here
        // — airing now would play it over whatever's currently on-air, one (or
        // more) tracks before this one reaches the front of dj_queue (issue
        // #189). airIntro() writes it to the voice file when the track starts.
        if (item.introScript && !item.introWav) {
          try {
            item.introWav = await speak(item.introScript, { kind: item.introKind || 'dj-speak' });
          } catch (err) {
            this.log('error', `TTS failed: ${(err as Error).message}`);
          }
        }

        // An operator cancel (removeUpcoming) may have spliced this item out
        // while we were awaiting the TTS render above — don't hand a removed
        // track to Liquidsoap.
        if (!this.upcoming.includes(item)) continue;

        // On-pick "a la carte" analysis (discussion #1032): when enabled and
        // this track still needs analysis, analyse it NOW — before the mix
        // transition below reads the library record — so this very hand-off
        // gets the fresh bpm/key/outro/vocal/loudness data. Bounded by the
        // deadline inside analyzeOnPick: past it the item drains with whatever
        // data exists (today's behaviour) and the analysis keeps running in
        // the background, caching its result for the next spin.
        //
        // Awaited ONLY when this is the sole pending hand-off. The drain loop
        // holds the senderBusy mutex — the single path every hand-off takes,
        // listener requests included — so blocking here with more items
        // waiting would serialize them all behind one track's analysis
        // (N×deadline in the worst case) and could leave dj_queue empty past
        // the current track's end. With others waiting, the analysis is
        // kicked off in the background instead: this item drains with
        // existing data and the result caches for its next spin.
        if (analyzeOnPickEnabled() && item.track?.id) {
          const othersWaiting = this.upcoming.some(i => i !== item && !i.sent);
          if (othersWaiting) {
            const title = item.track.title;
            analyzeOnPick(item.track.id)
              .then((got) => {
                // 'current'/'skipped' mean nothing ran — stay quiet in the
                // steady state; only an actual analysis earns a log line.
                if (got !== 'current' && got !== 'skipped') {
                  this.log('mix', `on-pick analysis backgrounded (more hand-offs waiting) — ${title} aired with existing data; result caches for next spin`);
                }
              })
              .catch(() => {});
          } else {
            try {
              const got = await analyzeOnPick(item.track.id);
              if (got === 'analyzed') {
                this.log('mix', `on-pick analysis cached → ${item.track.title}`);
              } else if (got === 'pending') {
                this.log('mix', `on-pick analysis still running — ${item.track.title} airs with existing data; result caches for next time`);
              }
            } catch (err) {
              // Same containment as the TTS await above: a transient library-db
              // throw must not reject the fire-and-forget drain promise.
              this.log('error', `On-pick analysis failed: ${(err as Error).message}`);
            }
            // Same guard as after the TTS await: an operator cancel may have
            // spliced this item out while we were analysing.
            if (!this.upcoming.includes(item)) continue;
          }
        }

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

        // Hard length cap (#447 max-track-length): stamp a cue_out so Liquidsoap
        // cuts an over-length autonomous pick mid-air. Explicit listener requests
        // (requestedBy set) stay exempt — a requested long mix plays in full,
        // mirroring the request path's selection-cap exemption in picker-tools.
        const maxDurationSec = item.requestedBy ? null : settings.effectiveMaxTrackSec();
        const uri = subsonic.getAnnotatedUri(item.track, { maxDurationSec });
        await writeHandoff(config.liquidsoap.queueFile, uri);
        item.sent = true;
        this.persist();  // record the sent flag — these are now live in dj_queue

        // writeHandoff already waited for Liquidsoap's poll to consume the
        // file before returning, so no extra sleep needed here.
      }
    } finally {
      this.senderBusy = false;
    }
  }

  // Speak something without queueing a track — for hourly time checks,
  // weather updates, station IDs, and auto DJ links.
  //
  // Dispatches to one of two Liquidsoap voice channels based on kind:
  //   - 'link' → intro.txt → intro_queue → LIGHT duck (talk-over feel: the
  //              song that just started stays audible underneath the voice)
  //   - everything else → say.txt → voice_queue → HEAVY duck (solo voice
  //              dominates; used for station ID / hourly / weather)
  //
  // `opts.persona` overrides the on-air persona for THIS clip's voice — the
  // persona-handoff mic-pass voices the outgoing DJ after the hour has flipped
  // (see broadcast/dj-agent.runPersonaHandoff). `opts.meta` is merged into the
  // session turn (e.g. tagging the sign-off with the outgoing persona id). Both
  // default to absent, so every existing call site is byte-identical.
  async announce(text, kind = 'announcement', { persona = null, meta = {} }: { persona?: Persona | null; meta?: TurnMeta } = {}) {
    if (!text || !text.trim()) return;
    try {
      const wavPath = await speak(text, { kind, persona });
      const targetFile = kind === 'link'
        ? config.liquidsoap.introFile
        : config.liquidsoap.sayFile;
      await airVoice(targetFile, wavPath, text, voiceGainDb(kind, persona));
      this.log(kind, text);
      session.appendTurn({ role: 'segment', kind, text, meta });
      // The auto-DJ link channel is its own event; everything else (station
      // IDs, weather, hourly) is `dj.say`. Operators that pipe these into
      // Discord usually want to filter the chatty link stream separately.
      webhooks.notify(kind === 'link' ? 'dj.link' : 'dj.say',
        kind === 'link' ? { text } : { text, kind });
    } catch (err) {
      this.log('error', `Announce failed: ${(err as Error).message}`);
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
        await airVoice(config.liquidsoap.sayFile, l.wavPath, l.text, voiceGainDb(kind, l.persona));
        this.log(kind, `${l.persona?.name ? `${l.persona.name}: ` : ''}${l.text}`);
        session.appendTurn({
          role: 'segment', kind, text: l.text,
          meta: { personaId: l.persona?.id, personaName: l.persona?.name },
        });
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

  // Defer a spoken segment to the NEXT track boundary instead of airing it
  // immediately. Used for station idents: they have no real-time constraint
  // (unlike the hourly time check), so ducking the current song mid-vocal at
  // an arbitrary wall-clock minute is pure loss — at a transition the same
  // ident lands like real radio. The WAV is rendered NOW (TTS latency off the
  // air path); onTrackStarted airs it via the light-duck intro channel so the
  // incoming song stays audible underneath, same feel as an auto-DJ link.
  //
  // One slot only: a newer pending segment replaces an unaired older one (on
  // an aggressive station a fresh ident supersedes a stale one rather than
  // stacking). All bookkeeping (djLog → recap/opener anti-repeat, session
  // turn, webhook) happens at AIR time, so the DJ's memory reflects what
  // actually reached the stream, not what was merely scheduled.
  async announceAtNextTrack(text, kind = 'announcement', { persona = null, meta = {} }: { persona?: Persona | null; meta?: TurnMeta } = {}) {
    if (!text || !text.trim()) return;
    try {
      const wavPath = await speak(text, { kind, persona });
      this._pendingVoice = { text, kind, wavPath, persona, meta, t: Date.now() };
      this.log('scheduler', `Holding ${kind} for the next track boundary`);
    } catch (err) {
      this.log('error', `Deferred announce failed: ${(err as Error).message}`);
    }
  }

  // Air the boundary-deferred segment, if one is pending. Called from
  // onTrackStarted BEFORE airIntro so the ident lands ahead of the track's own
  // link in the shared voice chain (ident → link reads as a natural hand-off).
  // The prompt context bakes in the local clock, so a clip that waited past
  // PENDING_VOICE_MAX_AGE_MS (a long mix, a stream stall) is dropped rather
  // than aired with a stale time reference — the next cron fire replaces it.
  async airPendingVoice() {
    const p = this._pendingVoice;
    if (!p) return;
    this._pendingVoice = null;
    if (Date.now() - p.t > PENDING_VOICE_MAX_AGE_MS) {
      this.log('scheduler', `Dropped pending ${p.kind} — waited too long for a track boundary`);
      return;
    }
    if (!existsSync(p.wavPath)) return;
    try {
      await airVoice(config.liquidsoap.introFile, p.wavPath, p.text, voiceGainDb(p.kind, p.persona));
      this.log(p.kind, p.text);
      session.appendTurn({ role: 'segment', kind: p.kind, text: p.text, meta: p.meta });
      webhooks.notify('dj.say', { text: p.text, kind: p.kind });
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
  async airIntro(item: QueueItem, predecessor: Track | null = null) {
    if (!item?.introWav || item.introAired || !existsSync(item.introWav)) return;
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
    const kind = item.introKind || 'dj-speak';
    const targetFile = kind === 'link'
      ? config.liquidsoap.introFile
      : config.liquidsoap.sayFile;
    try {
      await airVoice(targetFile, item.introWav, item.introScript || '', voiceGainDb(kind));
      this.persist();
      this.log(kind, item.introScript!);
      session.appendTurn({ role: 'segment', kind, text: item.introScript! });
      webhooks.notify(kind === 'link' ? 'dj.link' : 'dj.say',
        kind === 'link' ? { text: item.introScript } : { text: item.introScript, kind });
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

  // Called by the now-playing watcher when Liquidsoap reports a new track.
  onTrackStarted(np: NowPlaying | null) {
    if (!np || !np.title) return;
    const key = `${np.subsonic_id || ''}|${np.title}|${np.artist || ''}`;
    if (key === this.lastSeenKey) return;
    this.lastSeenKey = key;

    // A fresh track boundary — air any boundary-deferred segment (station
    // ident) now. Fired BEFORE airIntro below so the shared voice chain plays
    // ident → link in that order. Fire-and-forget for the same reason as
    // airIntro: must not stall the watcher tick.
    void this.airPendingVoice();

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
    // for older items that pre-date the id annotation.
    let idx = -1;
    if (np.subsonic_id) {
      idx = this.upcoming.findIndex(u => u.track.id && u.track.id === np.subsonic_id);
    }
    if (idx < 0) {
      idx = this.upcoming.findIndex(
        u => u.track.title === np.title && (u.track.artist || '') === (np.artist || '')
      );
    }

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

    // Milestone on the unified timeline — the anchor each pick trace hangs off.
    logEvent('track.play', {
      title: this.current.track.title,
      artist: this.current.track.artist || null,
      source: this.current.source,
      requestedBy: this.current.requestedBy || null,
    });

    const trackPayload = {
      title: this.current.track.title,
      artist: this.current.track.artist || null,
      album: this.current.track.album || null,
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
          const ctx = await getFullContext();
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
          try {
            await djAgent.runPersonaHandoff(this, ctx);
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
          // The pick made now airs when the track that just started ends — so
          // near a show boundary the rules to pick by are the NEXT show's, not
          // this one's (a pick queued minutes before the boundary used to
          // follow the outgoing show's brief, handing the incoming DJ an
          // off-format opener). Probe a little past the pick's expected start
          // so a pick that begins just shy of the boundary — and plays mostly
          // inside the new show — also counts as the new show's. The session
          // roll and handoff above stay on the live clock: only the pick
          // looks ahead. Unknown duration → no look-ahead, today's behaviour.
          const durSec = Number(this.current?.track?.duration);
          let pickCtx = ctx;
          let showAt: Date | null = null;
          if (Number.isFinite(durSec) && durSec > 0) {
            showAt = new Date(Date.now() + (durSec + PICK_SHOW_LOOKAHEAD_SEC) * 1000);
            pickCtx = await getFullContext(showAt);
          }
          await djAgent.runTrackEvent(this, pickCtx, { wantLink, showAt });
        } catch (err) {
          this.log('error', `DJ track event failed: ${(err as Error).message}`);
        } finally {
          this.pickerBusy = false;
        }
      })();
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

      // Empty dj_queue while we still hold sent items. On a single read this is
      // ambiguous — a pick may be mid-poll (written to next.txt, not yet pulled
      // in), Liquidsoap may have restarted and lost the queue, or the last item
      // is on-air (popped from the queue) but its metadata didn't match in
      // onTrackStarted so it never left `upcoming`. Don't drop on one read, but
      // count consecutive empties: once the queue has been authoritatively empty
      // for EMPTY_DJ_QUEUE_CLEAR_THRESHOLD checks the sent items are genuinely
      // gone (restart) or stuck, so clear them and let the auto-DJ — gated on
      // `upcoming.length === 0` — start picking again. This restores the restart
      // self-heal the old `_autoMisses` clear provided, without its false wipes:
      // it advances only on an authoritatively empty queue, so an interleaved
      // jingle or an artist-string mismatch (with tracks still queued) resets it
      // instead of tripping it.
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
      const rid = await liquidsoapControl.resolveDjQueueRid(trackId);
      if (!rid || !(await liquidsoapControl.removeFromDjQueue(rid))) {
        return { ok: false, reason: 'already-playing' };
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
  // (filterPickerCandidates hardRecent*; never relaxed). Clock-independent: it
  // walks the rolling sidecar newest-first and stops once it has seen `n`
  // distinct tracks, so a busy or a quiet hour blocks the same number of songs.
  //
  // Counts DISTINCT tracks, not raw rows: the sidecar can hold two entries for
  // one play (recordPlay logs it with an id at track-end; the boot events
  // backfill logs an id-less copy at track-start), and those collapse here —
  // `n` means n songs, not n rows — so the guard's strength matches the
  // configured number regardless of the double-write. Collapses an id-less
  // (backfilled) row against an id'd row of the same track via the shared
  // title|artist key. Returns BOTH ids and keys so a candidate is blocked by
  // whichever identifier it carries; the current track is added on top so a
  // mid-song pick can't re-pick it. Empty sets when n <= 0.
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

  // Poll now-playing.json every 1.5s and dispatch track changes. Each tick
  // also refreshes the in-memory copy getNowPlaying() serves, so the
  // per-listener /now-playing poll never has to touch the disk.
  startWatcher() {
    const tick = async () => {
      this._nowPlaying = await this.readNowPlayingFromDisk();
      this._nowPlayingFresh = true;
      this.onTrackStarted(this._nowPlaying);
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
    });
    return {
      current: this.current ? mapItem(this.current) : null,
      upcoming: this.upcoming.map(mapItem),
      history: this.history.map(mapItem),
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

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

// Do two track refs point at the same song? Used by the stale back-announce
// guard. Prefer the Subsonic id when both carry one (the reliable key); fall
// back to a normalised title match for auto-playlist tracks that reach the
// watcher without an id.
function sameTrack(
  a: { id?: string | null; title?: string | null } | null,
  b: { id?: string | null; title?: string | null } | null,
): boolean {
  if (!a || !b) return false;
  if (a.id && b.id) return a.id === b.id;
  const norm = (s: string | null | undefined) => (s || '').toLowerCase().trim();
  return !!norm(a.title) && norm(a.title) === norm(b.title);
}

// Does this spoken line actually name `track` (by title or artist)? A coarse
// case-insensitive substring test — enough to tell a forward-looking link
// ("here's something new") from one that back-announces a specific track ("that
// was Blue Monday by New Order"). The ≥4-char floor keeps a tiny/common title
// ("OK", "Go", "Up") from matching incidental words in unrelated patter.
function mentionsTrack(
  text: string | null | undefined,
  track: { title?: string | null; artist?: string | null } | null,
): boolean {
  const hay = (text || '').toLowerCase();
  if (!hay || !track) return false;
  const t = (track.title || '').toLowerCase().trim();
  const a = (track.artist || '').toLowerCase().trim();
  return (t.length >= 4 && hay.includes(t)) || (a.length >= 4 && hay.includes(a));
}

// Should airIntro DROP this item's intro/link as a stale back-announce? Links
// are written forward-looking (introduce the pick, never name the just-played
// track), so the common case never trips this. It's a precise safety-net for
// the model disobeying that instruction: fire ONLY when the rendered line names
// a specific predecessor (`linkPrev`) AND that track is NOT what actually played
// just before it — the off-by-one a listener request causes when it slips ahead
// of the pick after the link was rendered. A forward-looking link (doesn't name
// the previous track) always airs, even if a request jumped ahead, so there's no
// silent hand-off. Items with no linkPrev (request intros) always air too. Pure
// + exported so the guard is unit-pinned (scripts/stale-link.test.ts) without
// touching disk or TTS.
export function shouldDropStaleLink(
  item: { linkPrev?: { id?: string | null; title?: string | null; artist?: string | null } | null; introScript?: string | null } | null,
  predecessor: { id?: string | null; title?: string | null } | null,
): boolean {
  if (!item?.linkPrev) return false;
  if (sameTrack(item.linkPrev, predecessor)) return false;   // names the right track → fine
  return mentionsTrack(item.introScript, item.linkPrev);     // wrong predecessor — only drop if it's actually named
}

// Per-target-file write chain. Liquidsoap polls each handoff file (say.txt,
// intro.txt, sfx.txt, next.txt) on a 0.5-1.0s interval and DELETES the file
// after reading it (see liquidsoap/radio.liq poll_voice/poll_intro/poll_sfx/
// poll_queue). Without serialisation, two writes inside one poll window
// silently lose the first one — exactly the failure in issue #140 where a
// station ID rendered + logged but never aired.
//
// writeHandoff() serialises writes per file and waits for the previous WAV/URI
// to be consumed (file deleted by liquidsoap) before releasing the lock. If
// liquidsoap is dead/stuck and never deletes, we time out after maxWaitMs and
// release anyway — better to overwrite a stuck file than block all future
// announces forever.
const _handoffChains: Map<string, Promise<void>> = new Map();

async function waitForConsumed(path: string, maxWaitMs: number) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      await stat(path);
    } catch {
      return; // liquidsoap deleted it — file gone, safe to write next
    }
    await sleep(100);
  }
  // Timed out — file still on disk. Caller proceeds anyway.
}

async function writeHandoff(path: string, contents: string, { maxWaitMs = 1500 } = {}) {
  const prev = _handoffChains.get(path) || Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      // Make sure liquidsoap has already consumed whatever was there. If the
      // file doesn't exist (the common case — liquidsoap polled in the
      // meantime, or this is the first write of the session), this returns
      // immediately.
      if (existsSync(path)) await waitForConsumed(path, maxWaitMs);
      // Write-to-temp + rename so liquidsoap's poll never observes a
      // half-written (or truncated-but-empty) file — its poll handlers read,
      // DELETE, then check non-empty, so a poll landing mid-write would drop
      // this handoff silently. rename(2) is atomic on the same volume.
      await writeFileAtomic(path, contents);
    });
  // Hold the slot until liquidsoap consumes THIS write too, so the next
  // queued writer waits for the audio to land, not just for the write call to
  // return. Errors don't break the chain — the .catch above ensures the next
  // writer still gets its turn.
  const release = next.then(() => waitForConsumed(path, maxWaitMs).catch(() => undefined));
  _handoffChains.set(path, release);
  return next;
}

// --- Spoken-segment serialiser (issue #310) -------------------------------
//
// writeHandoff above stops two writes to ONE file from clobbering each other,
// but it releases the moment liquidsoap *reads* the path (~0.5s) — long before
// the ~20s of speech has actually played. And say.txt and intro.txt are
// separate chains, so nothing stopped a station ID / hourly check (say.txt)
// from airing on top of a between-track link (intro.txt), or two scheduled
// idents stacking when their cron handlers fired together.
//
// airVoice() chains EVERY spoken segment across BOTH channels through one lock
// and holds it for the clip's actual playback duration, so the next voice waits
// for silence instead of talking over the last one. The caller unblocks as soon
// as its own clip is handed to liquidsoap (writeHandoff resolved); only the
// *next* caller pays the duration wait.
let _voiceChain: Promise<void> = Promise.resolve();

const VOICE_LEADIN_MS = 800;   // /sounds/leadin.wav pushed before each spoken clip
const VOICE_TAIL_MS = 700;     // duck ramp-back + poll/scheduling slack
// Cap a single hold so a wildly-wrong duration estimate (or a clip that never
// really aired) can't wedge the voice channel for minutes.
const VOICE_HOLD_MAX_MS = 90_000;

async function airVoice(path: string, wavPath: string, text: string, gainDb = 0) {
  // Duration is read from the bare WAV path (header parse), so compute it BEFORE
  // wrapping — the annotate URI isn't a real file. The wrapped URI is only what
  // gets written to the handoff file for Liquidsoap to consume.
  const holdMs = Math.min(VOICE_HOLD_MAX_MS, speechDurationMs(wavPath, text));
  const uri = voiceUriWithGain(wavPath, gainDb);
  const turn = _voiceChain
    .catch(() => undefined)
    .then(async () => {
      // A jingle stinger may be on air (or inside the cross buffer) right now —
      // it plays outside this serialiser, so wait it out before handing over.
      await waitForJingleClear();
      return writeHandoff(path, uri);
    });
  // Extend the shared lock until this clip has (about) finished playing.
  _voiceChain = turn.then(() => sleep(holdMs)).then(() => {}, () => {});
  return turn;
}

// --- Jingle collision guard (issue #997) -----------------------------------
//
// Jingles rotate into the broadcast inside Liquidsoap (radio.liq's jingle
// rotate), entirely outside the airVoice serialiser — and because music_meta
// is captured ABOVE that rotate, the incoming track's on_metadata fires while
// the stinger is still audible in the crossfade, so a boundary-aired link or
// ident talked straight over it. radio.liq announces each jingle by writing
// jingle-playing.json ({filename, startedAt}) the moment it starts feeding;
// the clip stays audible for up to its own length plus the cross buffer.
// Before any voice handoff, sleep out whatever remains of that window.
//
// The marker is never deleted — a stale one simply computes a window in the
// past. If the jingle WAV can't be measured (non-WAV upload, path not visible
// to a native-dev controller), a fixed fallback length keeps the guard useful
// without wedging the chain.

const JINGLE_FALLBACK_MS = 15_000; // clip length when the WAV can't be parsed
const JINGLE_TAIL_MS = 1_000;      // fade tail + poll slack
const JINGLE_WAIT_MAX_MS = 60_000; // never wedge the voice chain on a bad marker

function jingleClearAtMs(): number {
  try {
    const m = JSON.parse(readFileSync(config.liquidsoap.jinglePlayingFile, 'utf8'));
    const startedMs = Number(m?.startedAt) * 1000; // liquidsoap time() is unix seconds
    if (!Number.isFinite(startedMs) || startedMs <= 0) return 0;
    const clipMs = (typeof m?.filename === 'string' && wavDurationMs(m.filename)) || JINGLE_FALLBACK_MS;
    const crossMs = (Number(settings.get()?.crossfadeDuration) || 10) * 1000;
    return startedMs + clipMs + crossMs + JINGLE_TAIL_MS;
  } catch {
    return 0; // no marker (or unreadable) — nothing on air to avoid
  }
}

async function waitForJingleClear() {
  const waitMs = Math.min(JINGLE_WAIT_MAX_MS, jingleClearAtMs() - Date.now());
  if (waitMs > 0) await sleep(waitMs);
}

// Wrap a rendered voice-clip path in a Liquidsoap `annotate:` URI carrying a
// liq_amplify gain, so the per-engine/persona voice trim is applied as the clip
// plays (radio.liq wraps the voice queues in amplify(override="liq_amplify")).
// 0 dB → the bare path, no annotation — byte-for-byte today's behaviour. Mirrors
// subsonic.getAnnotatedUri's liq_amplify="<n> dB" form (the music loudness path).
function voiceUriWithGain(wavPath: string, gainDb: number): string {
  return gainDb !== 0 ? `annotate:liq_amplify="${gainDb} dB":${wavPath}` : wavPath;
}

// Best-effort playback duration of a rendered voice clip, plus the lead-in and
// duck-tail padding. Reads the exact length from a WAV header (the local
// engines), and estimates from word count for anything else (cloud mp3).
function speechDurationMs(wavPath: string, text: string): number {
  const body = wavDurationMs(wavPath) ?? estimateSpeechMs(text);
  return body + VOICE_LEADIN_MS + VOICE_TAIL_MS;
}

// ~140 wpm, deliberately on the slow side so we over-, never under-estimate
// (an over-estimate just adds a little dead air; an under-estimate lets the
// next segment clip in over the tail).
function estimateSpeechMs(text: string): number {
  const words = (text || '').trim().split(/\s+/).filter(Boolean).length;
  return Math.ceil((words / 2.3) * 1000);
}

// Duration from a WAV header (byteRate from `fmt `, byte count from `data`).
// Returns null for non-WAV or anything it can't parse, so the caller falls back
// to the word-count estimate. Reads only the first 4KB — headers are tiny.
function wavDurationMs(path: string): number | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const head = Buffer.alloc(4096);
    const n = readSync(fd, head, 0, head.length, 0);
    if (n < 12 || head.toString('ascii', 0, 4) !== 'RIFF'
        || head.toString('ascii', 8, 12) !== 'WAVE') return null;
    let byteRate = 0;
    let dataSize = 0;
    let off = 12;
    while (off + 8 <= n) {
      const id = head.toString('ascii', off, off + 4);
      const size = head.readUInt32LE(off + 4);
      if (id === 'fmt ') {
        byteRate = head.readUInt32LE(off + 8 + 8);   // fmt body offset 8 → byteRate
      } else if (id === 'data') {
        dataSize = size;
        break;
      }
      off += 8 + size + (size % 2);   // chunks are word-aligned
    }
    if (!byteRate) return null;
    // Streamed WAVs sometimes write a bogus/placeholder data size — fall back
    // to the real file size minus the header we walked.
    if (!dataSize || dataSize > 0x7fffffff) {
      dataSize = Math.max(0, statSync(path).size - (off + 8));
    }
    if (!dataSize) return null;
    return Math.ceil((dataSize / byteRate) * 1000);
  } catch {
    return null;
  } finally {
    if (fd != null) closeSync(fd);
  }
}

// Voice kinds the DJ recap remembers. The fixed channels are always present;
// every skill kind (built-in + custom) is registered at skill-load time via
// registerSkillKinds() — so a new skill is recapped without editing this list.
// 'handoff' (the two-voice persona mic-pass) counts too, so the incoming DJ's
// next segments don't echo the greeting's opener.
const VOICE_KINDS = new Set(['dj-speak', 'link', 'station-id', 'hourly-check', 'handoff', 'banter']);
// The intro channels tied to a track start rather than the wall clock — the
// standalone-talk-break clock (getLastTalkBreakAt) skips them.
const TRACK_TIED_KINDS = new Set(['dj-speak', 'link']);
// How long a boundary-deferred segment may wait for a track start before it's
// dropped as stale (its prompt context baked in the clock at generation time).
// Comfortably past a long album cut, well short of the next ident sounding odd.
const PENDING_VOICE_MAX_AGE_MS = 20 * 60_000;
// Kinds whose recap entries are de-duped. Skills are added at load time too.
// 'handoff' is deliberately NOT deduped — its two lines (sign-off + greeting)
// are distinct utterances by different voices.
const DEDUPE_KINDS = new Set(['station-id', 'hourly-check']);
const KIND_LABEL: Record<string, string> = {
  'dj-speak': 'intro',
  'link': 'link',
  'station-id': 'ident',
  'hourly-check': 'hourly',
  'handoff': 'handoff',
  'banter': 'banter',
};

// Register the loaded skill kinds (built-in + custom) as recap voice/dedupe
// kinds. Called by skills/loader.js after each (re)load; idempotent (Sets).
export function registerSkillKinds(kinds: string[]): void {
  for (const k of kinds) {
    if (!k) continue;
    VOICE_KINDS.add(k);
    DEDUPE_KINDS.add(k);
  }
}

function formatAgo(ms: number) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${Math.max(1, s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export const queue = new Queue();
