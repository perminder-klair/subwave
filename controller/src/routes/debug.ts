// Admin-gated GET /debug — everything-at-a-glance for the debug UI.
import express from 'express';
import { readFile, readdir, stat } from 'node:fs/promises';
import { config } from '../config.js';
import * as dj from '../llm/dj.js';
import * as llmProvider from '../llm/provider.js';
import {
  rawDebugEnabled,
  rawDebugEnabledViaEnv,
  LLM_DEBUG_LOG,
  LLM_DEBUG_MAX,
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
import * as requestLog from '../broadcast/request-log.js';
import { getStationTimezone } from '../time.js';
import { publicOrigin } from './public.js';
import { requireAdmin } from '../middleware/auth.js';

export const router = express.Router();

// GET /requests — recent listener requests and exactly how the AI DJ resolved
// each (intent breakdown, which path handled it, the picked track, the spoken
// ack + full intro script, timing). Durable across restarts via request-log's
// on-disk JSONL. Feeds the dashboard's Requests card.
router.get('/requests', requireAdmin, (req, res) => {
  try {
    res.json({ requests: requestLog.snapshot(50) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// A debug snapshot is expensive to assemble — it loads the mood library, fetches
// Icecast + weather, sweeps the state dir with stat(), and serialises the whole
// DJ session (~170KB). The admin panel polls it every ~2s. Coalesce concurrent
// and rapid hits behind a tiny single-flight cache so a burst of polls — or
// several open admin tabs — triggers the build at most once per TTL, instead of
// stacking that work on the single-threaded event loop and starving other
// /api/* routes (the cause of the edge 524s).
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
  // Station zone so the DJ-log timestamps render in station-local time, matching
  // what the DJ speaks on-air (#418).
  let settingsSnapshot: any = null;
  try { settingsSnapshot = settings.get(); } catch { settingsSnapshot = null; }
  const out: any = {
    t: new Date().toISOString(),
    timezone: getStationTimezone(),
    locale: settingsSnapshot?.locale,
  };

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

  // 3. Icecast status — capture the full source array so the per-mount block
  // below can reuse it (one status-json fetch, not two).
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

  // 3b. Listen mounts — per-mount config vs. live Icecast status, plus the
  // tune-in files. `configured` is the operator's intent (mp3 is the mandatory
  // floor; opus/flac/aac are opt-in); `live` is whether Icecast actually has a
  // source on that mount. configured-but-not-live = encoder didn't connect /
  // needs a mixer restart — the diagnostic this surfaces.
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
    // Daily token budget — today's usage vs the cap and the resulting tier
    // (normal / soft / hard). `enabled:false` when no cap is set.
    budget: (() => { try { return budgetStatus(); } catch (err: any) { return { error: err.message }; } })(),
    recentCalls: dj.recentCalls,
    // Raw-request capture status — the admin UI shows the toggle + the file path
    // so operators know where to look. `viaEnv` means LLM_DEBUG_RAW forces it on
    // (the UI toggle can't turn it off in that case).
    debug: {
      enabled: rawDebugEnabled(),
      viaEnv: rawDebugEnabledViaEnv(),
      file: LLM_DEBUG_LOG,
      max: LLM_DEBUG_MAX,
    },
  };

  // 6c. TTS routing — which engine/voice the effective persona resolves to,
  // and whether it's silently falling back from the engine the persona asked
  // for (e.g. a cloud voice with the Cloud engine switched off). Plus the raw
  // TTS call ring (stats.ts, same since-boot window as the LLM ring) so the
  // debug panel can show what actually aired, per call.
  try {
    out.tts = { ...tts.describeRouting(), recentCalls: ttsCalls };
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

  // 6d. Subsonic API call tracking — every request to Navidrome, plus
  // library-coverage stats (distinct songs returned vs. tagged total).
  try {
    out.subsonic = subsonicLog.snapshot(out.library?.total ?? null);
  } catch (err) {
    out.subsonic = { error: err.message };
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
  out.config = {
    navidromeUrl: config.navidrome.url,
    navidromeUser: config.navidrome.user,
    location: settingsSnapshot?.weather?.locationName || config.weather.locationName,
    port: config.server.port,
  };

  return out;
}

// GET /sessions — archived session list, newest first. The live session is
// served inline by /debug; this lists the rolled-off runs in state/sessions/.
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

// POST /debug/subsonic/reset — zero the Subsonic call tracker so coverage can
// be watched building from scratch during a targeted test run.
router.post('/debug/subsonic/reset', requireAdmin, (req, res) => {
  subsonicLog.reset();
  res.json({ ok: true });
});
