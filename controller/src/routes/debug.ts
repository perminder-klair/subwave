// Admin-gated GET /debug — everything-at-a-glance for the debug UI.
import express from 'express';
import { readFile, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { config } from '../config.js';
import * as dj from '../llm/dj.js';
import * as llmProvider from '../llm/provider.js';
import {
  rawDebugEnabled,
  rawDebugEnabledViaEnv,
  LLM_DEBUG_LOG,
  LLM_DEBUG_MAX,
  agentDoneRetryCount,
  llmCallExportFormat,
  llmCallExportFilename,
  serializeLlmCalls,
  LLM_CALL_EXPORT_CONTENT_TYPE,
} from '../llm/log.js';
import * as tts from '../audio/tts.js';
import { ttsCalls } from '../stats.js';
import * as library from '../music/library.js';
import * as subsonicLog from '../music/subsonic-log.js';
import { getFullContext } from '../context.js';
import * as settings from '../settings.js';
import { queue } from '../broadcast/queue.js';
import * as session from '../broadcast/session.js';
import { budgetStatus } from '../broadcast/dj-budget.js';
import { voiceStatus } from '../broadcast/voice-policy.js';
import { clockStatus } from '../broadcast/clock-policy.js';
import { talkAirStatus } from '../broadcast/talk-air.js';
import { jingleRotateStatus } from '../broadcast/jingle-rotate.js';
import { LIQ_JINGLE_RATIO_PATH } from '../settings/liquidsoap.js';
import { handoverStatus } from '../broadcast/handover-policy.js';
import * as requestLog from '../broadcast/request-log.js';
import { getStationTimezone } from '../time.js';
import { publicOrigin } from './public.js';
import { requireAdmin } from '../middleware/auth.js';
import { BadStatePathError, listStateDir } from '../util/state-tree.js';

export const router = express.Router();

// Recent listener requests and how the DJ resolved each. Durable across
// restarts via request-log's on-disk JSONL.
router.get('/requests', requireAdmin, (req, res) => {
  try {
    res.json({ requests: requestLog.snapshot(50) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The snapshot is expensive (mood library, Icecast + weather fetches, whole DJ
// session) and the admin panel polls it every ~2s, so concurrent and rapid hits
// coalesce behind this single-flight cache; without it several open tabs starve
// the other /api/* routes.
const DEBUG_CACHE_TTL_MS = 1000;
let debugCache: { at: number; payload: any } | null = null;
let debugInflight: Promise<any> | null = null;

router.get('/debug', requireAdmin, async (req, res) => {
  try {
    const now = Date.now();
    if (debugCache && now - debugCache.at < DEBUG_CACHE_TTL_MS) {
      res.json(debugCache.payload);
      return;
    }
    if (!debugInflight) {
      debugInflight = buildDebugSnapshot(req)
        .then((payload) => { debugCache = { at: Date.now(), payload }; return payload; })
        .finally(() => { debugInflight = null; });
    }
    res.json(await debugInflight);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

async function buildDebugSnapshot(req: express.Request): Promise<any> {
  // Station zone so DJ-log timestamps render in station-local time (#418).
  let settingsSnapshot: any = null;
  try { settingsSnapshot = settings.get(); } catch { settingsSnapshot = null; }
  const out: any = {
    t: new Date().toISOString(),
    timezone: getStationTimezone(),
    locale: settingsSnapshot?.locale,
  };

  // What Liquidsoap last wrote.
  try {
    out.nowPlaying = JSON.parse(await readFile(config.liquidsoap.nowPlayingFile, 'utf8'));
  } catch (err) {
    out.nowPlaying = { error: err.message };
  }

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
    upcoming: queue.upcoming.map((i: any) => ({
      title: i.track.title, artist: i.track.artist,
      requestedBy: i.requestedBy, aiPicked: i.aiPicked,
    })),
    historyCount: queue.history.length,
    djLogCount: queue.djLog.length,
    djLog: queue.djLog.slice(0, 30),
    autoPick: queue.autoPick,
    pickerBusy: queue.pickerBusy,
  };

  // Capture the full source array so the per-mount block below reuses it
  // (one status-json fetch, not two).
  let icecastSources: any[] = [];
  try {
    const r = await fetch(config.icecast.statusUrl);
    const ic: any = (await r.json() as any).icestats;
    icecastSources = Array.isArray(ic.source) ? ic.source : ic.source ? [ic.source] : [];
    const src = icecastSources[0];
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

  // Per-mount config vs live Icecast status. `configured` is operator intent
  // (mp3 is the mandatory floor), `live` is whether Icecast has a source on it;
  // configured-but-not-live means the encoder didn't connect.
  {
    const st = settingsSnapshot?.stream || {};
    const origin = publicOrigin(req);
    const audioParam = (src: any, key: 'samplerate' | 'channels'): number | null => {
      const direct = Number(src?.[key]);
      if (Number.isFinite(direct) && direct > 0) return direct;
      const m = String(src?.audio_info || '').match(new RegExp(`${key}=([0-9]+)`, 'i'));
      return m ? Number(m[1]) : null;
    };
    const mountEntry = (
      path: string,
      codec: string,
      configured: boolean,
      configuredBitrate: number | null,
    ) => {
      const src = icecastSources.find((s: any) =>
        String(s?.listenurl || '').includes(path),
      );
      const live = !!src;
      const liveBitrate = Number(src?.bitrate);
      return {
        path,
        codec,
        configured,
        live,
        bitrate: live && Number.isFinite(liveBitrate) ? liveBitrate : configuredBitrate,
        listeners: live ? Number(src.listeners || 0) : null,
        sampleRate: live ? audioParam(src, 'samplerate') : null,
        channels: live ? audioParam(src, 'channels') : null,
        contentType: live ? src.server_type || null : null,
        url: `${origin}${path}`,
      };
    };
    const list = [
      mountEntry('/stream.mp3', 'MP3', true, st.bitrate ?? 192),
      mountEntry('/stream.opus', 'Opus', st.opusEnabled === true, st.opusBitrate ?? 96),
      mountEntry('/stream.flac', 'FLAC', st.flacEnabled === true, null),
      mountEntry('/stream.aac', 'AAC-LC', st.aacEnabled === true, st.aacBitrate ?? 192),
    ];
    out.mounts = {
      list,
      tuneIn: {
        entryCount: list.filter(m => m.configured).length,
        pls: `${origin}/listen.pls`,
        m3u: `${origin}/listen.m3u`,
      },
    };
  }

  // radio.log is install-level: the compose bind mount pins it to the state
  // ROOT's logs/, which can't follow the active-station pointer. The station-dir
  // fallback covers the window after a multi-station conversion, where the mount
  // still follows the moved inode until the broadcast container is recreated.
  try {
    const log = await readFile(`${config.stateRoot}/logs/radio.log`, 'utf8')
      .catch(() => readFile(`${config.stateDir}/logs/radio.log`, 'utf8'));
    out.liquidsoapLog = log.split('\n').slice(-100).join('\n');
  } catch (err) {
    out.liquidsoapLog = `error: ${err.message}`;
  }

  // No state-dir listing here on purpose: it is browsed lazily, one directory
  // per expand, via GET /debug/state-tree below.
  out.llm = {
    provider: llmProvider.providerName(),
    activeModel: llmProvider.activeModelLabel(),
    ollamaUrl: llmProvider.activeOllamaUrl(),
    // Today's usage vs the cap; enabled:false when no cap is set.
    budget: (() => { try { return budgetStatus(); } catch (err: any) { return { error: err.message }; } })(),
    // settings.tts.enabled; false means every autonomous talk moment stands down.
    voice: (() => { try { return voiceStatus(); } catch (err: any) { return { error: err.message }; } })(),
    // settings.djSpeakClock; false means the hourly time check stands down.
    clock: (() => { try { return clockStatus(); } catch (err: any) { return { error: err.message }; } })(),
    // settings.djTalkOnlyBetweenTracks; true means a late-looking segment is
    // waiting for a track boundary rather than missing.
    talkAir: (() => { try { return talkAirStatus(); } catch (err: any) { return { error: err.message }; } })(),
    // Who draws the automatic jingle (settings.jingleRotate, #1619). `owner`
    // answers both halves of "why are there no stingers" and "why are there
    // two of them", and while the controller owns the rotate
    // `tracksSinceJingle` says how close the next one is.
    //
    // The ratio is reported TWICE — intended (from settings) and on-disk (the
    // verbatim bytes of the handoff file) — because they can disagree, and the
    // disagreement IS the "why are there two of them" answer. The read is here
    // rather than in the policy module so that module stays I/O-free; it is one
    // small synchronous read on an admin-only route that already does several.
    // An unreadable file reports `null`, never a guess: the file is absent on a
    // station that has never saved settings, and that is not the same claim as
    // the mixer having been handed the wrong value.
    jingleRotate: (() => {
      try {
        let onDisk: string | null = null;
        try { onDisk = readFileSync(LIQ_JINGLE_RATIO_PATH, 'utf8').trim(); } catch { onDisk = null; }
        return jingleRotateStatus(settings.get(), queue.rotateJingleTracksSince(), onDisk);
      } catch (err: any) { return { error: err.message }; }
    })(),
    // Show handover timing + ordering (settings.handover, #1576). `offsetMinutes`
    // is how far before a show boundary the sign-off airs and `closingTrack` is
    // the fixed rule that keeps the incoming host one track behind it — but the
    // config alone cannot tell "waiting" from "missing", which is the question
    // this row exists for. `wait` is the LIVE debt: null when no sign-off is
    // outstanding (so an absent greeting is missing), and the two counters
    // against those thresholds when one is (so it is waiting, and for what).
    handover: (() => {
      try { return { ...handoverStatus(), wait: queue.handoverWait() }; }
      catch (err: any) { return { error: err.message }; }
    })(),
    // Since-boot count of the strategy layer's "stopped without calling done"
    // retries.
    agentDoneRetries: agentDoneRetryCount(),
    recentCalls: dj.recentCalls,
    // viaEnv means LLM_DEBUG_RAW forces capture on and the UI toggle can't
    // turn it off.
    debug: {
      enabled: rawDebugEnabled(),
      viaEnv: rawDebugEnabledViaEnv(),
      file: LLM_DEBUG_LOG,
      max: LLM_DEBUG_MAX,
    },
  };

  // Which engine/voice the effective persona resolves to, whether it is
  // silently falling back, plus the since-boot TTS call ring.
  try {
    out.tts = { ...tts.describeRouting(), recentCalls: ttsCalls };
  } catch (err) {
    out.tts = { error: err.message };
  }

  try {
    await library.load();
    out.library = library.stats();
  } catch (err) {
    out.library = { error: err.message };
  }

  // Every request to Navidrome plus library-coverage stats.
  try {
    out.subsonic = subsonicLog.snapshot(out.library?.total ?? null);
  } catch (err) {
    out.subsonic = { error: err.message };
  }

  try {
    out.context = await getFullContext();
  } catch (err) {
    out.context = { error: err.message };
  }

  try {
    out.session = session.getSession();
  } catch (err) {
    out.session = { error: err.message };
  }

  // Effective values, not the env defaults: the admin location setting
  // overrides env-derived config. LLM config is already in out.llm.
  out.config = {
    navidromeUrl: config.navidrome.url,
    navidromeUser: config.navidrome.user,
    // `location` drives the forecast; `onAirLocation` is what the DJ says and
    // what the public endpoints publish.
    location: settingsSnapshot?.weather?.locationName || config.weather.locationName,
    onAirLocation: settings.resolveOnAirLocation(settingsSnapshot ?? { weather: config.weather }),
    port: config.server.port,
  };

  return out;
}

// Archived sessions in state/sessions/, newest first; the live one is in /debug.
router.get('/sessions', requireAdmin, async (req, res) => {
  try {
    let names: string[] = [];
    try {
      names = (await readdir(config.session.dir)).filter((n: string) => n.endsWith('.json'));
    } catch { names = []; }
    const entries: any[] = await Promise.all(names.map(async (name: string) => {
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
      sessions: entries.filter(Boolean).sort((a: any, b: any) => (b.startedAt || '').localeCompare(a.startedAt || '')),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ONE directory of the active station dir, metadata only. There is deliberately
// no content endpoint beside it: settings.json, secrets.env and
// icecast-secrets.env all live in this tree and hold live credentials.
router.get('/debug/state-tree', requireAdmin, async (req, res) => {
  const rel = typeof req.query.path === 'string' ? req.query.path : '';
  try {
    res.json(await listStateDir(config.stateDir, rel));
  } catch (err: any) {
    // A malformed path is a bad request; a missing/unreadable one is a failed
    // listing the panel renders inline.
    if (err instanceof BadStatePathError) {
      res.status(400).json({ error: err.message });
      return;
    }
    res.json({ root: config.stateDir, path: rel, entries: [], shown: 0, total: 0, error: err.message });
  }
});

// The recent-calls ring as a download (#1485). `?format=ndjson` for one call
// per line, else a single JSON document. It writes the same array /debug serves
// as `llm.recentCalls` VERBATIM: adding or filtering a field here makes this a
// second, divergent reader of the log. Deliberately outside the snapshot cache
// above (a one-shot download must reflect the ring at press time) and outside
// the Connect catalog.
router.get('/debug/llm-calls/export', requireAdmin, (req, res) => {
  try {
    const format = llmCallExportFormat(req.query.format);
    const body = serializeLlmCalls(dj.recentCalls, format);
    res.setHeader('Content-Type', LLM_CALL_EXPORT_CONTENT_TYPE[format]);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${llmCallExportFilename(format)}"`,
    );
    // The ring is a since-boot window that moves under any cache.
    res.setHeader('Cache-Control', 'no-store');
    res.send(body);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// Zero the Subsonic call tracker so coverage can be watched from scratch.
router.post('/debug/subsonic/reset', requireAdmin, (req, res) => {
  subsonicLog.reset();
  res.json({ ok: true });
});
