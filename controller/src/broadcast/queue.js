// Queue manager — keeps the in-memory queue and writes track URIs
// to the file Liquidsoap watches. A now-playing watcher rotates items
// between upcoming → current → history based on what Liquidsoap reports.

import { writeFile, readFile } from 'node:fs/promises';
import { config } from '../config.js';
import * as subsonic from '../music/subsonic.js';
import * as dj from '../llm/dj.js';
import { speak } from '../audio/tts.js';
import { pickAndEnqueue } from '../music/picker.js';
import { getFullContext } from '../context.js';
import * as settings from '../settings.js';

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
  constructor() {
    this.upcoming = [];        // request items pushed by listeners, not yet playing
    this.current = null;       // what's broadcasting right now (request or auto)
    this.history = [];         // finished tracks, newest first
    this.djLog = [];           // controller-level events for the web UI
    this.lastSeenKey = null;   // for change detection in the watcher
    this.senderBusy = false;   // drain-to-Liquidsoap mutex
    this.pickerBusy = false;   // prevent concurrent LLM picks
    this.autoPick = true;      // toggle: should we ask Ollama for next track when idle
    this.autoLink = true;      // toggle: random DJ links between auto tracks
    this.tracksUntilLink = pickLinkInterval();
    this.linkBusy = false;
  }

  log(kind, message, meta = {}) {
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
    const seenDedupe = new Set();
    const picked = [];
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
    return picked.map(e => {
      const ago = formatAgo(Date.now() - new Date(e.t).getTime());
      const msg = (e.message || '').replace(/\s+/g, ' ').trim();
      const truncated = msg.length > maxChars ? msg.slice(0, maxChars - 1) + '…' : msg;
      return `- ${ago} ago [${KIND_LABEL[e.kind] || e.kind}]: "${truncated}"`;
    }).join('\n');
  }

  // Recently played tracks, newest first. Compact shape for prompts.
  getRecentTracks(n = 6) {
    const out = [];
    for (const h of this.history.slice(0, n)) {
      const t = h.track;
      if (!t || !t.title) continue;
      out.push({ title: t.title, artist: t.artist || null, album: t.album || null, year: t.year || null });
    }
    return out;
  }

  // Deduped recent artist names, newest first.
  getRecentArtists(n = 6) {
    const seen = new Set();
    const out = [];
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
    const seen = new Set();
    const out = [];
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
  async push({ track, requestedBy = null, intent = null, introScript = null, aiPicked = false }) {
    const item = {
      track, requestedBy, intent, introScript, aiPicked,
      queuedAt: new Date().toISOString(),
      sent: false,
    };
    this.upcoming.push(item);
    this.log('queued', `${track.title} — ${track.artist}`, { requestedBy, queueDepth: this.upcoming.length });
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
          } catch (err) {
            this.log('error', `TTS failed: ${err.message}`);
          }
        }

        const uri = subsonic.getAnnotatedUri(item.track);
        await writeFile(config.liquidsoap.queueFile, uri);
        item.sent = true;

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
    } catch (err) {
      this.log('error', `Announce failed: ${err.message}`);
    }
  }

  // Called by the now-playing watcher when Liquidsoap reports a new track.
  onTrackStarted(np) {
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
      const item = this.upcoming.splice(idx, 1)[0];
      const source = item.aiPicked ? 'ai' : 'request';
      this.current = { ...item, startedAt: new Date().toISOString(), source };
      this.log('playing', `${np.title} — ${np.artist}`, { requestedBy: item.requestedBy, source });
    } else {
      // Not a tracked request → auto-playlist or jingle
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

    // Random DJ link between auto tracks. Listener requests are skipped entirely —
    // they already get a bespoke intro and shouldn't count toward the gap.
    const isAutonomous = this.current.source === 'auto' || this.current.source === 'ai';
    if (this.autoLink && isAutonomous) {
      this.tracksUntilLink--;
      if (this.tracksUntilLink <= 0 && this.history[0] && !this.linkBusy) {
        this.tracksUntilLink = pickLinkInterval();
        this.linkBusy = true;
        const previous = this.history[0].track;
        const current = this.current.track;
        (async () => {
          try {
            const ctx = await getFullContext();
            const script = await dj.generateLink({
              previous,
              current,
              context: ctx,
              recap: this.getDjRecap(),
              recentTracks: this.getRecentTracks(),
              recentOpeners: this.getRecentOpeners(),
            });
            await this.announce(script, 'link');
          } catch (err) {
            this.log('error', `DJ link failed: ${err.message}`);
          } finally {
            this.linkBusy = false;
          }
        })();
      }
    }

    // Auto-DJ: if nothing is queued, ask the LLM to pick the next track.
    // Fire-and-forget — by the time the current track ends, the pick should
    // already be in Liquidsoap's dj_queue, so there's no gap.
    if (this.autoPick && this.upcoming.length === 0 && !this.pickerBusy) {
      this.pickerBusy = true;
      pickAndEnqueue(this)
        .catch(err => this.log('error', `picker failed: ${err.message}`))
        .finally(() => { this.pickerBusy = false; });
    }
  }

  // IDs of tracks played in the last N entries — used by scheduler to avoid repeats
  recentlyPlayedIds(n = 25) {
    const ids = [];
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
    const mapItem = i => ({
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

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

const VOICE_KINDS = new Set(['dj-speak', 'link', 'station-id', 'hourly-check', 'weather', 'news', 'traffic', 'random-facts']);
const DEDUPE_KINDS = new Set(['station-id', 'hourly-check', 'weather', 'news', 'traffic', 'random-facts']);
const KIND_LABEL = {
  'dj-speak': 'intro',
  'link': 'link',
  'station-id': 'ident',
  'hourly-check': 'hourly',
  'weather': 'weather',
  'news': 'news',
  'traffic': 'traffic',
  'random-facts': 'fact',
};

function formatAgo(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${Math.max(1, s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export const queue = new Queue();
