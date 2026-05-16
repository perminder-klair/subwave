// Admin-gated GET /debug — everything-at-a-glance for the debug UI.
import express from 'express';
import { readFile, readdir, stat } from 'node:fs/promises';
import { config } from '../config.js';
import * as dj from '../llm/dj.js';
import * as llmProvider from '../llm/provider.js';
import * as tts from '../audio/tts.js';
import * as library from '../music/library.js';
import { getFullContext } from '../context.js';
import * as settings from '../settings.js';
import { queue } from '../broadcast/queue.js';
import * as session from '../broadcast/session.js';
import { requireAdmin } from '../middleware/auth.js';

export const router = express.Router();

router.get('/debug', requireAdmin, async (req, res) => {
  const out = { t: new Date().toISOString() };

  // 1. now-playing.json (what Liquidsoap last wrote)
  try {
    out.nowPlaying = JSON.parse(await readFile(config.liquidsoap.nowPlayingFile, 'utf8'));
  } catch (err) {
    out.nowPlaying = { error: err.message };
  }

  // 2. Queue snapshot (current + upcoming + history + djLog)
  out.queue = {
    current: queue.current ? {
      title: queue.current.track.title,
      artist: queue.current.track.artist,
      album: queue.current.track.album,
      requestedBy: queue.current.requestedBy,
      source: queue.current.source,
      intent: queue.current.intent,
      introScript: queue.current.introScript,
    } : null,
    upcoming: queue.upcoming.map(i => ({
      title: i.track.title, artist: i.track.artist,
      requestedBy: i.requestedBy, aiPicked: i.aiPicked,
    })),
    historyCount: queue.history.length,
    djLogCount: queue.djLog.length,
    djLog: queue.djLog.slice(0, 30),
    autoPick: queue.autoPick,
    pickerBusy: queue.pickerBusy,
  };

  // 3. Icecast status
  try {
    const r = await fetch('http://icecast:7702/status-json.xsl');
    const ic = (await r.json()).icestats;
    const src = Array.isArray(ic.source) ? ic.source[0] : ic.source;
    out.icecast = src ? {
      title: src.title,
      bitrate: src.bitrate,
      listeners: src.listeners,
      listener_peak: src.listener_peak,
      mount: src.listenurl,
      stream_start: src.stream_start_iso8601,
      server_start: ic.server_start_iso8601,
    } : { error: 'no source connected' };
  } catch (err) {
    out.icecast = { error: err.message };
  }

  // 4. Liquidsoap log tail — Liquidsoap writes radio.log into the shared
  // state dir's logs/ subfolder (see radio.liq + the liquidsoap volume
  // mount), which the controller sees via the shared state mount.
  // Reading it here means no extra controller-side log mount is needed.
  try {
    const log = await readFile(`${config.stateDir}/logs/radio.log`, 'utf8');
    out.liquidsoapLog = log.split('\n').slice(-100).join('\n');
  } catch (err) {
    out.liquidsoapLog = `error: ${err.message}`;
  }

  // 5. State dir listing
  try {
    const dir = config.stateDir;
    const entries = await readdir(dir);
    out.stateFiles = await Promise.all(entries.map(async (name) => {
      try {
        const s = await stat(`${dir}/${name}`);
        return { name, size: s.size, mtime: s.mtime.toISOString(), isDir: s.isDirectory() };
      } catch { return { name, error: true }; }
    }));
    const voiceDir = `${dir}/voice`;
    try {
      const v = await readdir(voiceDir);
      out.voiceFiles = await Promise.all(v.map(async (name) => {
        const s = await stat(`${voiceDir}/${name}`);
        return { name, size: s.size, mtime: s.mtime.toISOString() };
      }));
    } catch {}
  } catch (err) {
    out.stateFiles = { error: err.message };
  }

  // 6. Recent LLM calls — `llm` reflects the active provider/model resolved
  // by the registry; `ollamaUrl` is the effective endpoint (settings or default).
  out.llm = {
    provider: llmProvider.providerName(),
    activeModel: llmProvider.activeModelLabel(),
    ollamaUrl: llmProvider.activeOllamaUrl(),
    recentCalls: dj.recentCalls,
  };

  // 6c. TTS routing — which engine/voice the effective persona resolves to,
  // and whether it's silently falling back from the engine the persona asked
  // for (e.g. a cloud voice with the Cloud engine switched off).
  try {
    out.tts = tts.describeRouting();
  } catch (err) {
    out.tts = { error: err.message };
  }

  // 6b. Library tagging stats
  try {
    await library.load();
    out.library = library.stats();
  } catch (err) {
    out.library = { error: err.message };
  }

  // 7. Context snapshot
  try {
    out.context = await getFullContext();
  } catch (err) {
    out.context = { error: err.message };
  }

  // 7b. Live DJ session — the current run's chat history.
  try {
    out.session = session.getSession();
  } catch (err) {
    out.session = { error: err.message };
  }

  // 8. Config (redacted) — show *effective* values: the admin UI's location
  // setting overrides the env-derived config, so read that from settings
  // (falling back to config) rather than the stale env default. The LLM
  // provider/model/endpoint is provider-agnostic (any AI SDK provider or
  // router) and already reported in `out.llm` — not duplicated here.
  let s = null;
  try { s = settings.get(); } catch { s = null; }
  out.config = {
    navidromeUrl: config.navidrome.url,
    navidromeUser: config.navidrome.user,
    location: s?.weather?.locationName || config.weather.locationName,
    port: config.server.port,
  };

  res.json(out);
});

// GET /sessions — archived session list, newest first. The live session is
// served inline by /debug; this lists the rolled-off runs in state/sessions/.
router.get('/sessions', requireAdmin, async (req, res) => {
  try {
    let names = [];
    try {
      names = (await readdir(config.session.dir)).filter(n => n.endsWith('.json'));
    } catch { names = []; }
    const entries = await Promise.all(names.map(async (name) => {
      try {
        const s = JSON.parse(await readFile(`${config.session.dir}/${name}`, 'utf8'));
        return {
          id: s.id, kind: s.kind, key: s.key,
          startedAt: s.startedAt, endedAt: s.endedAt,
          show: s.show?.name || null,
          persona: s.persona?.name || null,
          turns: Array.isArray(s.messages) ? s.messages.length : 0,
        };
      } catch { return null; }
    }));
    res.json({
      sessions: entries.filter(Boolean).sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || '')),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
