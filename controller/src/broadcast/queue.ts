// Queue manager — keeps the in-memory queue and writes track URIs
// to the file Liquidsoap watches. A now-playing watcher rotates items
// between upcoming → current → history based on what Liquidsoap reports.

import { writeFile, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { config } from '../config.js';
import * as subsonic from '../music/subsonic.js';
import { speak } from '../audio/tts.js';
import * as djAgent from './dj-agent.js';
import * as sfx from './sfx.js';
import * as session from './session.js';
import { getFullContext } from '../context.js';
import * as settings from '../settings.js';
import { logEvent } from '../observability/events.js';
import { djCallsAllowed } from './listeners.js';
import * as webhooks from './webhooks.js';

// Random gap between DJ links on auto-played tracks. The frequency setting
// scales how chatty the DJ is:
//   quiet      → uniform 8-20 tracks between links
//   moderate   → current behaviour (1-9 85% of the time, 10-15 the other 15%)
//   aggressive → uniform 1-3 tracks
function pickLinkInterval() {
  const f = settings.getEffectivePersona()?.frequency || 'moderate';
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
  _persistTimer: NodeJS.Timeout | null = null; // debounce for the queue.json snapshot
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
  async push({ track, requestedBy = null, intent = null, introScript = null, aiPicked = false }: {
    track: any;
    requestedBy?: string | null;
    intent?: string | null;
    introScript?: string | null;
    aiPicked?: boolean;
  }) {
    const item = {
      track, requestedBy, intent, introScript, aiPicked,
      queuedAt: new Date().toISOString(),
      sent: false,
    };
    this.upcoming.push(item);
    this.log('queued', `${track.title} — ${track.artist}`, { requestedBy, queueDepth: this.upcoming.length });
    this.persist();
    this.drainToLiquidsoap();  // fire-and-forget
    return this.upcoming.length;
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

        if (item.introScript) {
          try {
            const wavPath = await speak(item.introScript, { kind: 'dj-speak' });
            await writeFile(config.liquidsoap.sayFile, wavPath);
            this.log('dj-speak', item.introScript);
            await sleep(250);
          } catch (err: any) {
            this.log('error', `TTS failed: ${err.message}`);
          }
        }

        const uri = subsonic.getAnnotatedUri(item.track);
        await writeFile(config.liquidsoap.queueFile, uri);
        item.sent = true;
        this.persist();  // record the sent flag — these are now live in dj_queue

        // Give Liquidsoap's 1s poll a chance to read + delete the file
        // before we overwrite it with the next item.
        await sleep(1500);
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
      await writeFile(targetFile, wavPath);
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
      await writeFile(config.liquidsoap.sfxFile, path);
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

    // Roll previous current into history
    if (this.current) {
      this.history.unshift({ ...this.current, endedAt: new Date().toISOString() });
      this.history = this.history.slice(0, 50);
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

  // IDs of tracks played in the last N entries — used by scheduler to avoid repeats
  recentlyPlayedIds(n = 25) {
    const ids: string[] = [];
    if (this.current?.track?.id) ids.push(this.current.track.id);
    for (const h of this.history.slice(0, n)) {
      if (h.track?.id) ids.push(h.track.id);
    }
    return new Set(ids);
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

const VOICE_KINDS = new Set(['dj-speak', 'link', 'station-id', 'hourly-check', 'weather', 'news', 'traffic', 'random-facts', 'web-search']);
const DEDUPE_KINDS = new Set(['station-id', 'hourly-check', 'weather', 'news', 'traffic', 'random-facts', 'web-search']);
const KIND_LABEL: Record<string, string> = {
  'dj-speak': 'intro',
  'link': 'link',
  'station-id': 'ident',
  'hourly-check': 'hourly',
  'weather': 'weather',
  'news': 'news',
  'traffic': 'traffic',
  'random-facts': 'fact',
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
