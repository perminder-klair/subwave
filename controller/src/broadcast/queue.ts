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
import { speak } from '../audio/tts.js';
import * as djAgent from './dj-agent.js';
import * as sfx from './sfx.js';
import * as session from './session.js';
import { getFullContext, energyForDaypart } from '../context.js';
import * as settings from '../settings.js';
import { logEvent } from '../observability/events.js';
import { djCallsAllowed } from './listeners.js';
import * as webhooks from './webhooks.js';
import * as scrobble from './scrobble.js';

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
  _persistTimer: NodeJS.Timeout | null = null; // debounce for the queue.json snapshot
  _recentPlaysTimer: NodeJS.Timeout | null = null; // debounce for the recent-plays.json sidecar
  _recentPlays: { id: string | null; title: string | null; artist: string | null; endedAt: string }[] = [];
  _autoMisses = 0;             // consecutive untracked plays — see onTrackStarted

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
      // Dedup by `t|title` against existing sidecar (which records endedAt
      // close to the play.start time; near-enough that exact equality works).
      const have = new Set(
        this._recentPlays.map(p => `${p.endedAt}|${p.title || ''}`),
      );
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
            if (have.has(`${e.t}|${e.title}`)) continue;
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
  async push({ track, requestedBy = null, intent = null, introScript = null, introKind = 'dj-speak', aiPicked = false }: {
    track: any;
    requestedBy?: string | null;
    intent?: string | null;
    introScript?: string | null;
    introKind?: string;
    aiPicked?: boolean;
  }) {
    const item = {
      track, requestedBy, intent, introScript, introKind, aiPicked,
      introWav: null as string | null,
      introAired: false,
      queuedAt: new Date().toISOString(),
      sent: false,
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

  // How many transitions must pass between DJ-mode transition-FX, keyed off the
  // chattiness ladder. Infinity for quiet personas → no transition FX at all.
  sfxTransitionGap(): number {
    const f = settings.effectiveFrequency();
    if (f === 'aggressive') return 4;
    if (f === 'moderate') return 8;
    return Infinity;
  }

  // DJ-mode mixing applied to the transition INTO `item`'s track (features 1 &
  // 2). No-op unless the active persona is in DJ mode. Stashes a per-transition
  // crossfade length on the track (read by subsonic.getAnnotatedUri →
  // liq_cross_duration) and, on a notable upward tempo jump, fires a rate-
  // limited riser across the blend. Both require both tracks to be analysed.
  applyMixTransition(item: any) {
    const persona = settings.getEffectivePersona();
    if (!persona?.djMode || !item?.track) return;

    const idx = this.upcoming.indexOf(item);
    const prevTrack = (idx > 0 ? this.upcoming[idx - 1]?.track : null) || this.current?.track || null;
    if (!prevTrack) return;

    const cur = this.mixAnalysisFor(prevTrack);
    const next = this.mixAnalysisFor(item.track);

    // Feature 1 — adaptive blend length, with a subtle daypart nudge.
    let energyDelta = 0;
    try { energyDelta = energyForDaypart().speed - 1; } catch {}
    const secs = mix.crossSecondsFor(cur, next, { energyDelta });
    if (secs != null) {
      item.track.crossSec = secs;
      this.log('mix', `blend ${secs}s → ${item.track.title}`);
    }

    // Feature 2 — transition FX, spaced by the chattiness ladder and gated on
    // settings.sfx.enabled; never two transitions in a row.
    this._transitionsSinceSfx++;
    if (settings.get().sfx?.enabled && this._transitionsSinceSfx >= this.sfxTransitionGap()) {
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

        const uri = subsonic.getAnnotatedUri(item.track);
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
  async announce(text, kind = 'announcement') {
    if (!text || !text.trim()) return;
    try {
      const wavPath = await speak(text, { kind });
      const targetFile = kind === 'link'
        ? config.liquidsoap.introFile
        : config.liquidsoap.sayFile;
      await airVoice(targetFile, wavPath, text);
      this.log(kind, text);
      session.appendTurn({ role: 'segment', kind, text });
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
  async airIntro(item: any) {
    if (!item?.introWav || item.introAired || !existsSync(item.introWav)) return;
    item.introAired = true;
    const kind = item.introKind || 'dj-speak';
    const targetFile = kind === 'link'
      ? config.liquidsoap.introFile
      : config.liquidsoap.sayFile;
    try {
      await airVoice(targetFile, item.introWav, item.introScript || '');
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
  // to garnish a spoken line.
  async playSfx(name: string) {
    if (!name) return;
    try {
      const path = await sfx.getPath(name);
      if (!path) {
        this.log('error', `Unknown sound effect: ${name}`);
        return;
      }
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
      this._autoMisses = 0;
      // Air this track's intro/link now that it's actually on-air — deferred
      // from queue time so the voice lands over the right song (#189). Fire-
      // and-forget: airIntro's writeHandoff can block up to maxWaitMs and must
      // not stall the 1.5s watcher tick. Use the live `this.current` so the
      // introAired flag is set on the tracked object.
      void this.airIntro(this.current);
    } else {
      // Not a tracked request → auto-playlist or jingle.
      // If we keep seeing untracked plays while `upcoming` is non-empty, those
      // queued items aren't actually in Liquidsoap's dj_queue — the usual cause
      // is a full-stack restart that wiped dj_queue while the controller
      // recovered a stale queue.json. Drop the stale items so the auto-DJ
      // (gated on `upcoming.length === 0`) starts picking again. The threshold
      // tolerates an interleaved jingle without clearing a genuine pending pick.
      this._autoMisses++;
      if (this._autoMisses >= 3 && this.upcoming.length > 0) {
        this.log('scheduler',
          `Cleared ${this.upcoming.length} stale queue item(s) — not in Liquidsoap's dj_queue`);
        this.upcoming = [];
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
          await djAgent.runTrackEvent(this, ctx, { wantLink });
        } catch (err: any) {
          this.log('error', `DJ track event failed: ${err.message}`);
        } finally {
          this.pickerBusy = false;
        }
      })();
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

async function airVoice(path: string, wavPath: string, text: string) {
  const holdMs = Math.min(VOICE_HOLD_MAX_MS, speechDurationMs(wavPath, text));
  const turn = _voiceChain
    .catch(() => undefined)
    .then(() => writeHandoff(path, wavPath));
  // Extend the shared lock until this clip has (about) finished playing.
  _voiceChain = turn.then(() => sleep(holdMs)).then(() => {}, () => {});
  return turn;
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

const VOICE_KINDS = new Set(['dj-speak', 'link', 'station-id', 'hourly-check', 'weather', 'news', 'traffic', 'curiosity', 'album-anniversary', 'library-deep-cut', 'web-search']);
const DEDUPE_KINDS = new Set(['station-id', 'hourly-check', 'weather', 'news', 'traffic', 'curiosity', 'album-anniversary', 'library-deep-cut', 'web-search']);
const KIND_LABEL: Record<string, string> = {
  'dj-speak': 'intro',
  'link': 'link',
  'station-id': 'ident',
  'hourly-check': 'hourly',
  'weather': 'weather',
  'news': 'news',
  'traffic': 'traffic',
  'curiosity': 'curiosity',
  'album-anniversary': 'anniversary',
  'library-deep-cut': 'deep-cut',
  'web-search': 'web',
};

function formatAgo(ms: number) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${Math.max(1, s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export const queue = new Queue();
