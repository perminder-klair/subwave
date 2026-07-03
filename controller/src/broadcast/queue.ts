// Queue manager — keeps the in-memory queue and writes track URIs
// to the file Liquidsoap watches. A now-playing watcher rotates items
// between upcoming → current → history based on what Liquidsoap reports.

import { writeFile, readFile } from 'node:fs/promises';
import { existsSync, readFileSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { stat, rename } from 'node:fs/promises';
import { config } from '../config.js';
import * as subsonic from '../music/subsonic.js';
import * as mix from '../music/mix.js';
import * as library from '../music/library.js';
import { speak, voiceGainDb } from '../audio/tts.js';
import * as djAgent from './dj-agent.js';
import * as sfx from './sfx.js';
import * as session from './session.js';
import { getFullContext, energyForDaypart } from '../context.js';
import * as settings from '../settings.js';
import { logEvent } from '../observability/events.js';
import { djCallsAllowed } from './listeners.js';
import * as webhooks from './webhooks.js';
import * as scrobble from './scrobble.js';
import * as liquidsoapControl from './liquidsoap-control.js';

// Random gap between DJ links on auto-played tracks. The frequency setting
// scales how chatty the DJ is:
//   quiet      → uniform 8-20 tracks between links
//   moderate   → current behaviour (1-9 85% of the time, 10-15 the other 15%)
//   aggressive → uniform 1-3 tracks
// A DJ-mode persona reads one rung chattier (effectiveFrequency), so it links
// transitions far more often — a working DJ talks across most of them.
function pickLinkInterval() {
  const f = settings.effectiveFrequency();
  if (f === 'quiet')      return 8 + Math.floor(Math.random() * 13);
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
  upcoming: any[] = [];        // request items pushed by listeners, not yet playing
  current: any = null;         // what's broadcasting right now (request or auto)
  history: any[] = [];         // finished tracks, newest first
  djLog: any[] = [];           // controller-level events for the web UI
  lastSeenKey: string | null = null;   // for change detection in the watcher
  senderBusy = false;          // drain-to-Liquidsoap mutex
  pickerBusy = false;          // prevent concurrent LLM picks
  autoPick = true;             // toggle: should we ask Ollama for next track when idle
  autoLink = true;             // toggle: random DJ links between auto tracks
  tracksUntilLink = pickLinkInterval();
  _transitionsSinceSfx = 999;  // DJ-mode transition-FX spacing counter (see drainToLiquidsoap)
  _recentEffects: string[] = [];  // the model's last few transition CHOICES — anti-streak guard + fed back into the pick event turn
  _persistTimer: NodeJS.Timeout | null = null; // debounce for the queue.json snapshot
  _recentPlaysTimer: NodeJS.Timeout | null = null; // debounce for the recent-plays.json sidecar
  _recentPlays: { id: string | null; title: string | null; artist: string | null; endedAt: string }[] = [];
  _emptyDjQueueStreak = 0;      // consecutive reconcile checks seeing an empty dj_queue while sent items remain — see reconcileWithDjQueue

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
        await writeFile(config.queue.file, JSON.stringify({
          upcoming: this.upcoming,
          current: this.current,
          history: this.history,
          savedAt: new Date().toISOString(),
        }, null, 2));
      } catch (err: any) {
        console.error('[queue] persist failed:', err.message);
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
        await writeFile(config.queue.recentPlaysFile,
          JSON.stringify(this._recentPlays, null, 2));
      } catch (err: any) {
        console.error('[queue] recent-plays persist failed:', err.message);
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
        .filter((i: any) => i?.track?.title && new Date(i.queuedAt || 0).getTime() > cutoff);
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
    } catch (err: any) {
      console.error('[queue] recover failed:', err.message);
    }
    if (existsSync(config.queue.recentPlaysFile)) {
      try {
        const arr = JSON.parse(readFileSync(config.queue.recentPlaysFile, 'utf8'));
        if (Array.isArray(arr)) {
          // Drop anything older than 48h on boot — keeps the file from
          // ballooning if the cap was raised between restarts.
          const cutoff = Date.now() - 48 * 3_600_000;
          this._recentPlays = arr
            .filter((p: any) => p && p.endedAt && new Date(p.endedAt).getTime() > cutoff)
            .slice(0, config.queue.recentPlaysMax);
        }
      } catch (err: any) {
        console.error('[queue] recent-plays recover failed:', err.message);
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
    } catch (err: any) {
      console.error('[queue] backfill from events failed:', err.message);
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
    const picked: any[] = [];
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
    return picked.map((e: any) => {
      const ago = formatAgo(Date.now() - new Date(e.t).getTime());
      const msg = (e.message || '').replace(/\s+/g, ' ').trim();
      const truncated = msg.length > maxChars ? msg.slice(0, maxChars - 1) + '…' : msg;
      return `- ${ago} ago [${KIND_LABEL[e.kind] || e.kind}]: "${truncated}"`;
    }).join('\n');
  }

  // Recently played tracks, newest first. Compact shape for prompts.
  getRecentTracks(n = 6) {
    const out: any[] = [];
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
    track: any;
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

  // Resolve {bpm, key} for a queued track: from the track object if it carries
  // analysis, else a library lookup (queued items hold only id/title/artist).
  mixAnalysisFor(track: any): { bpm: number | null; key: string | null } {
    if (!track) return { bpm: null, key: null };
    if (track.bpm != null || track.musicalKey != null) {
      return { bpm: track.bpm ?? null, key: track.musicalKey ?? null };
    }
    const rec = track.id ? library.get(track.id) : null;
    return { bpm: rec?.bpm ?? null, key: rec?.musicalKey ?? null };
  }

  // Resolve a track's integrated loudness + measured peak (track object first,
  // else a library lookup) and stash a clamped gain offset toward the
  // operator's loudness target on the track as `gainDb`. The peak lets
  // gainForLoudness cap the boost by real headroom instead of a blind clamp.
  // Null measurement → leaves gainDb undefined, so getAnnotatedUri emits no
  // liq_amplify and the track plays at unity gain.
  applyLoudnessGain(track: any) {
    if (!track) return;
    let lufs = track.loudnessLufs;
    let peakDb = track.peakDb;
    if ((lufs == null || peakDb == null) && track.id) {
      const rec = library.get(track.id);
      if (lufs == null) lufs = rec?.loudnessLufs ?? null;
      if (peakDb == null) peakDb = rec?.peakDb ?? null;
    }
    const loud = settings.get().loudness;
    const gain = mix.gainForLoudness(lufs, {
      peakDb,
      targetLufs: loud?.targetLufs,
      maxBoostDb: loud?.maxBoostDb,
    });
    if (gain != null) track.gainDb = gain;
  }

  // How many transitions must pass between DJ-mode transition-FX, keyed off the
  // chattiness ladder. Infinity for quiet personas → no transition FX at all.
  sfxTransitionGap(): number {
    const f = settings.effectiveFrequency();
    if (f === 'aggressive') return 4;
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
  stripEffect(track: any, reason: string) {
    const kind = track.sweep ? 'sweep' : track.blend ? 'blend' : 'washout';
    delete track.sweep;
    delete track.washout;
    delete track.blend;
    this.log('mix', `${kind} dropped (${reason})`);
  }

  // DJ-mode mixing applied to the transition INTO `item`'s track (features 1 &
  // 2, plus the sweep/washout transition effects). No-op unless the active
  // persona is in DJ mode. Stashes a per-transition crossfade length on the
  // track (read by subsonic.getAnnotatedUri → liq_cross_duration) and, on a
  // notable upward tempo jump, fires a rate-limited riser across the blend.
  applyMixTransition(item: any) {
    const persona = settings.getEffectivePersona();
    if (!item?.track) return;
    // Persona flipped out of DJ mode between the pick and the drain: the
    // effects gate below never runs, so make sure no flag survives to annotate.
    if (!persona?.djMode) {
      if (item.track.sweep || item.track.washout || item.track.blend) this.stripEffect(item.track, 'dj mode off');
      return;
    }

    const idx = this.upcoming.indexOf(item);
    const prevTrack = (idx > 0 ? this.upcoming[idx - 1]?.track : null) || this.current?.track || null;
    if (!prevTrack) {
      // Nothing on-air to validate against (first track after boot) — an
      // effect on a cold start would garnish silence; drop it.
      if (item.track.sweep || item.track.washout || item.track.blend) this.stripEffect(item.track, 'no predecessor');
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
    if (cappedExit && !item.track.washout) {
      item.track.washout = true;
      item.track.washoutAuto = true;
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
    if (item.track.sweep && !mix.effectAllowedFor('sweep', cur, next)) {
      delete item.track.sweep;
      this.log('mix', 'sweep dropped (tracks too compatible — beat-blend beats a sweep)');
    }
    if (item.track.sweep) this.log('mix', `sweep armed → ${item.track.title}`);
    // blend is the sweep's mirror (entry-side, flagged on the incoming pick):
    // it only makes sense between COMPATIBLE tracks — the handover exposes a
    // clash rather than hiding it.
    if (item.track.blend && !mix.effectAllowedFor('blend', cur, next)) {
      delete item.track.blend;
      this.log('mix', 'blend dropped (tracks clash — a handover needs a compatible pair)');
    }
    if (item.track.blend) this.log('mix', `blend armed → ${item.track.title}`);
    if (item.track.washout) {
      item.track.crossSec = mix.washoutCrossSecondsFor(next, maxSec);
      item.track.washoutDelay = mix.washoutDelayFor(next.bpm);
      const why = item.track.washoutAuto ? ' (length-cap exit)' : '';
      this.log('mix', `washout armed${why}: ${item.track.crossSec}s canvas, ${item.track.washoutDelay}s tap → ${item.track.title}`);
    }
    const effectFired = !!(item.track.sweep || item.track.washout || item.track.blend);

    // Feature 2 — transition FX, spaced by the chattiness ladder and gated on
    // settings.sfx.enabled; never two transitions in a row, and never a riser
    // over a sweep/washout transition.
    this._transitionsSinceSfx++;
    if (!effectFired && settings.get().sfx?.enabled && this._transitionsSinceSfx >= this.sfxTransitionGap()) {
      const fx = mix.transitionSfxFor(cur, next);
      if (fx) {
        this._transitionsSinceSfx = 0;
        void this.playSfx(fx);
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
          } catch (err: any) {
            this.log('error', `TTS failed: ${err.message}`);
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
        // not just DJ mode. Resolve the track's integrated loudness (from the
        // item or a library lookup) and stash a clamped gain offset toward the
        // target; subsonic.getAnnotatedUri folds it into liq_amplify. Un-measured
        // tracks resolve to null → no liq_amplify → unity gain, i.e. today.
        this.applyLoudnessGain(item.track);

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
  async announce(text, kind = 'announcement', { persona = null, meta = {} }: { persona?: any; meta?: any } = {}) {
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
    } catch (err: any) {
      this.log('error', `Announce failed: ${err.message}`);
    }
  }

  // Air a queued item's track-tied intro/link. Called from onTrackStarted the
  // moment the item's track actually starts playing, so the voice lands over
  // the RIGHT song rather than over whatever was on-air when it was queued
  // (issue #189). The WAV was rendered ahead of time in drainToLiquidsoap, so
  // this just writes the path to the duck channel and mirrors the bookkeeping
  // announce() does (djLog feeds the opener anti-repeat; session + webhook).
  async airIntro(item: any, predecessor: any = null) {
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
        `Dropped stale link before "${item.track?.title}" — it named "${item.linkPrev.title}" but "${predecessor?.title || 'another track'}" actually played first`);
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
      this.log(kind, item.introScript);
      session.appendTurn({ role: 'segment', kind, text: item.introScript });
      webhooks.notify(kind === 'link' ? 'dj.link' : 'dj.say',
        kind === 'link' ? { text: item.introScript } : { text: item.introScript, kind });
    } catch (err: any) {
      this.log('error', `Air intro failed: ${err.message}`);
    }
  }

  // Play a pre-rendered sound effect from the library UNDER the DJ voice.
  // Writes the effect's file path straight to sfx.txt — no TTS, the audio is
  // already rendered. Liquidsoap's sfx_queue mixes it beneath the voice
  // channels (see liquidsoap/radio.liq). Used by the segment-director agent
  // to garnish a spoken line, and by applyMixTransition for between-track
  // stingers.
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
    } catch (err: any) {
      this.log('error', `playSfx failed: ${err.message}`);
    }
  }

  // Called by the now-playing watcher when Liquidsoap reports a new track.
  onTrackStarted(np: any) {
    if (!np || !np.title) return;
    const key = `${np.subsonic_id || ''}|${np.title}|${np.artist || ''}`;
    if (key === this.lastSeenKey) return;
    this.lastSeenKey = key;

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

    // Outbound fan-out — fire-and-forget; never blocks the picker path.
    webhooks.notify('track.play', {
      title: this.current.track.title,
      artist: this.current.track.artist || null,
      album: this.current.track.album || null,
      source: this.current.source,
      requestedBy: this.current.requestedBy || null,
    });

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
          // If that roll crossed a persona boundary, air the mic-pass first
          // (sign-off + greeting) so it plays before the incoming DJ's first
          // pick. Guarded so a handoff failure never blocks the next track.
          try {
            await djAgent.runPersonaHandoff(this, ctx);
          } catch (err: any) {
            this.log('error', `Persona handoff failed: ${err.message}`);
          }
          await djAgent.runTrackEvent(this, ctx, { wantLink });
        } catch (err: any) {
          this.log('error', `DJ track event failed: ${err.message}`);
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
    } catch (err: any) {
      this.log('error', `reconcileWithDjQueue failed: ${err.message}`);
    }
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

  // Poll now-playing.json every 1.5s and dispatch track changes
  startWatcher() {
    setInterval(async () => {
      const np = await this.getNowPlaying();
      this.onTrackStarted(np);
    }, 1500);
    this.log('scheduler', 'Now-playing watcher started');
  }

  snapshot() {
    const mapItem = (i: any) => ({
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

  // Read the now-playing JSON Liquidsoap writes
  async getNowPlaying() {
    try {
      const raw = await readFile(config.liquidsoap.nowPlayingFile, 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}

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
      await writeFile(`${path}.tmp`, contents);
      await rename(`${path}.tmp`, path);
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
    .then(() => writeHandoff(path, uri));
  // Extend the shared lock until this clip has (about) finished playing.
  _voiceChain = turn.then(() => sleep(holdMs)).then(() => {}, () => {});
  return turn;
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
const VOICE_KINDS = new Set(['dj-speak', 'link', 'station-id', 'hourly-check', 'handoff']);
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
