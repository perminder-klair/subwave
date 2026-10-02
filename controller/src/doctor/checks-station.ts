// Checks over the station's own configuration: which capabilities are enabled,
// what the host can afford to run, and whether the tuning knobs are coherent.
//
// Part of the doctor/ split - see ../doctor.ts for the section runner.

import { recentCalls } from '../llm/log.js';
import { searchReady, searchWeb } from '../skills/web-search.js';
import * as system from '../system.js';
import { budgetStatus } from '../broadcast/dj-budget.js';
import { hlsActive } from '../broadcast/hls-policy.js';
import * as analyzer from '../music/analyzer.js';
import * as db from '../music/library-db.js';
import * as stemCache from '../music/stem-cache.js';
import type { Finding, StationSettings } from './types.js';
import { fmtTokens, isSchemaFailure } from './util.js';

export async function checkCapabilities(s: StationSettings | null): Promise<Finding[]> {
  const out: Finding[] = [];

  // Web search — backs the DJ's artist-news segments. DuckDuckGo is keyless;
  // Tavily needs a key. Report config readiness, then do a short live probe so
  // "is it actually working?" is answered, not just "is it configured?".
  const provider = s?.search?.provider || 'duckduckgo';
  let ready = true;
  try { ready = searchReady(); } catch { ready = true; }

  if (!ready) {
    out.push({
      label: 'web search',
      status: 'warn',
      detail: `${provider} selected but no API key`,
      hint: 'Artist-news segments can\'t fetch. Add a Tavily key (SEARCH_API_KEY) or switch to DuckDuckGo (keyless) in Settings → Search.',
    });
    return out;
  }

  // Live probe, raced against a 5s timeout so a hung provider can't stall the run.
  let okLive = false;
  let reason = '';
  try {
    await Promise.race([
      searchWeb('SUB-WAVE radio diagnostic ping').then(() => { okLive = true; }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), 5000)),
    ]);
  } catch (err) {
    reason = err?.message || 'unreachable';
  }
  out.push({
    label: 'web search',
    status: okLive ? 'ok' : 'warn',
    detail: okLive ? `${provider} · reachable` : `${provider} · ${reason}`,
    hint: okLive
      ? undefined
      : 'The artist-news segment needs outbound web access. Check the controller can reach the internet / the search provider.',
  });

  return out;
}

export async function checkResources(): Promise<Finding[]> {
  const out: Finding[] = [];
  try {
    const sys = await system.summary();
    const h = sys.host;
    const gb = (b: number) => (b / (1024 ** 3)).toFixed(1);
    const memPct = h.memTotal ? Math.round((h.memUsed / h.memTotal) * 100) : 0;

    out.push({
      label: 'CPU',
      status: 'ok',
      detail: `${h.cpus} cores · load ${h.loadavg.map((n) => n.toFixed(2)).join(' / ')}`,
    });
    out.push({
      label: 'memory',
      status: memPct > 90 ? 'warn' : 'ok',
      detail: `${gb(h.memUsed)} / ${gb(h.memTotal)} GB used (${memPct}%)`,
      hint: memPct > 90
        ? 'Memory is tight — heavy TTS (Chatterbox / PocketTTS) and large local models may struggle. Prefer Piper/Kokoro and a smaller model.'
        : undefined,
    });
    if (sys.dockerAvailable) {
      const top = sys.containers[0];
      out.push({
        label: 'containers',
        status: 'ok',
        detail: top
          ? `${sys.containers.length} running · busiest ${top.service} ${top.cpuPct}% CPU`
          : `${sys.containers.length} running`,
      });
    }
  } catch (err) {
    out.push({ label: 'host resources', status: 'skip', detail: err?.message || 'unavailable' });
  }
  return out;
}

// Tuning — the cross-setting + telemetry-vs-config checks that the settings
// panel itself can't show. Each finding weighs one performance knob against the
// OTHER settings, the live LLM telemetry, or the host resources — the stuff an
// operator can't eyeball. Findings are advisory (no one-click fix): the remedy
// is a settings change, which DJ Doc's review then narrates the trade-off for.
export async function checkTuning(s: StationSettings | null): Promise<Finding[]> {
  const out: Finding[] = [];
  const llm: NonNullable<StationSettings['llm']> = s?.llm || {};

  // --- Daily token budget: cliff detection + burn-rate projection ---
  // Uses the live tally (broadcast/dj-budget), not just the configured number,
  // so it can say "you'll hit the cap by mid-afternoon" instead of "a cap is set".
  try {
    const b = budgetStatus();
    if (!b.enabled) {
      out.push({ label: 'token budget', status: 'skip', detail: 'no daily cap (unlimited)' });
    } else {
      // A soft tier of 0 or 100 disables graceful degrade — the DJ jumps from
      // full service straight to silent at the cap.
      if (b.softPct <= 0 || b.softPct >= 100) {
        out.push({
          label: 'budget soft tier',
          status: 'warn',
          detail: `soft tier disabled (softPct ${b.softPct})`,
          hint: 'With no soft tier the DJ jumps straight from full service to silent at the cap. Set Settings → LLM → budget soft % to ~80 so it first drops to the cheap pool picker and mutes optional segments, warning you before it hits the wall.',
        });
      }
      // Project today's exhaustion from the burn rate so far (UTC day).
      const now = Date.now();
      const dayStart = Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
      const hrsElapsed = Math.max(0.05, (now - dayStart) / 3600000);
      const rate = b.usedToday / hrsElapsed; // tokens/hour
      const willExhaust = b.mode !== 'hard' && rate * 24 > b.cap && b.usedToday > 0;
      const hitHour = willExhaust ? Math.min(24, Math.round(b.cap / rate)) : null;
      const pct = b.cap > 0 ? Math.round((b.usedToday / b.cap) * 100) : 0;
      out.push({
        label: 'token budget',
        status: b.mode === 'hard' ? 'fail' : b.mode === 'soft' || willExhaust ? 'warn' : 'ok',
        detail:
          b.mode === 'hard'
            ? `cap reached (${fmtTokens(b.usedToday)}/${fmtTokens(b.cap)}) — DJ is coasting on the auto playlist`
            : `${fmtTokens(b.usedToday)}/${fmtTokens(b.cap)} used today (${pct}%)${willExhaust ? ` · on track to hit the cap ~${hitHour}:00 UTC` : ''}`,
        hint:
          b.mode === 'hard'
            ? 'No model calls until UTC midnight (listener requests still run if exempt). Raise Settings → LLM → daily token cap, or turn on pause-when-empty so idle hours don’t burn the budget.'
            : willExhaust
              ? 'At the current rate the DJ drops to the cheap picker (soft), then goes silent (hard) before the day ends. Raise the cap, enable pause-when-empty, or ease off reasoning / the agentic picker to slow the burn.'
              : undefined,
      });
    }
  } catch { /* budget module best-effort */ }

  // --- Agent deadline vs MEASURED latency ---
  // checkLlm only warns when the configured number looks low; here we compare it
  // to what the model is actually doing. If p90 latency crowds the deadline, the
  // agentic picker is silently timing out into the pool on most tracks.
  if (llm.pickerAgent !== false) {
    const lat = recentCalls
      .filter((c) => c && c.ok !== false && Number.isFinite(c.ms) && c.ms > 0)
      .map((c) => c.ms as number)
      .sort((a, b) => a - b);
    const deadlineMs = Number(llm.agentTimeoutMs);
    if (lat.length >= 5 && Number.isFinite(deadlineMs) && deadlineMs > 0) {
      const p90 = lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.9))];
      const ratio = p90 / deadlineMs;
      out.push({
        label: 'agent deadline vs latency',
        status: ratio >= 1 ? 'fail' : ratio >= 0.8 ? 'warn' : 'ok',
        detail: `p90 model latency ${(p90 / 1000).toFixed(1)}s vs ${Math.round(deadlineMs / 1000)}s deadline`,
        hint:
          ratio >= 0.8
            ? 'Recent calls are running close to (or past) the agent deadline, so the agentic picker is probably timing out into the pool fallback on many tracks — you lose the session-aware picks you’re paying for. Raise Settings → LLM → agent deadline, or switch to a faster/smaller model (or turn reasoning OFF).'
            : undefined,
      });
    }
  }

  // --- Context window too small for the agentic picker (Ollama only) ---
  if (llm.provider === 'ollama' && llm.pickerAgent !== false) {
    const nc = Number(llm.numCtx);
    if (Number.isFinite(nc) && nc > 0 && nc < 8192) {
      out.push({
        label: 'context window',
        status: 'warn',
        detail: `numCtx ${nc} — tight for the agentic picker`,
        hint: 'The agentic picker sends a system prompt + tool definitions + candidates; a small Ollama context window truncates them so the agent can’t call its “done” tool and falls back to the pool. Raise Settings → LLM → context window to ≥8192 (16384 is the default), or turn the agentic picker off.',
      });
    }
  }

  // --- Reasoning vs structured output (cross-setting, telemetry-backed) ---
  // "Thinking" tokens are a common cause of malformed JSON. Tie the risk to the
  // actual schema-failure count so it only fires when both are true.
  if (llm.reasoning) {
    const schemaFails = recentCalls.filter(isSchemaFailure).length;
    if (schemaFails > 0) {
      out.push({
        label: 'reasoning vs structured output',
        status: 'warn',
        detail: `reasoning ON with ${schemaFails} recent schema failure(s)`,
        hint: 'Chain-of-thought output is a common cause of malformed structured JSON (the picker, request matcher, tagger and this report all need strict JSON). Try turning Settings → LLM → reasoning OFF and re-checking — most local models emit cleaner JSON without it.',
      });
    }
  }

  // --- Max response size too small for the agentic picker ---
  {
    const mo = Number(llm.maxOutputTokens);
    if (Number.isFinite(mo) && mo > 0 && mo < 1000 && llm.pickerAgent !== false) {
      out.push({
        label: 'max response size',
        status: 'warn',
        detail: `maxOutputTokens ${mo} — low for the agentic picker`,
        hint: 'A small per-call output cap can truncate the agent’s tool calls mid-JSON, forcing a fallback. Leave Settings → LLM → max response size at 0 (strategy default) unless a small-context local model specifically needs it.',
      });
    }
  }

  // --- Listener-request web-resolve needs web search configured ---
  if (llm.requestWebResolve) {
    let ready = true;
    try { ready = searchReady(); } catch { ready = true; }
    if (!ready) {
      out.push({
        label: 'request web-resolve',
        status: 'warn',
        detail: 'on, but web search isn’t ready',
        hint: 'Resolving described track requests ("that song from the film") needs a working web search. Configure it in Settings → Search, or turn Settings → LLM → request web-resolve off.',
      });
    }
  }

  // --- Audio-analysis features vs the analyzer flavour actually running ---
  // audio.embeddings / vocalActivity silently no-op on the lean analyzer image
  // (no CLAP / Demucs). Cross-check the setting against the live capability probe.
  try {
    const wantEmb = !!s?.audio?.embeddings;
    const wantVocal = !!s?.audio?.vocalActivity;
    if (wantEmb || wantVocal) {
      try { await analyzer.refreshCapabilities(); } catch { /* best-effort probe */ }
      // The upgrade path depends on which backend is running: 'sidecar' is the
      // split stack's analyzer service; 'local' is the in-process venv — the
      // AIO image (or a dev ANALYZE_PYTHON venv). Pointing an AIO operator at
      // the analyzer image replaces their whole station with a bare analyzer
      // micro-service (issue #966), so the hint has to name the right image.
      const upgradeHint = analyzer.backendLabel() === 'local'
        ? 'On the all-in-one image, switch the container to ghcr.io/perminder-klair/subwave-aio-heavy (NOT subwave-analyzer-heavy — that’s the bare analyzer service, not a station image); on a dev venv, install the heavy Python deps.'
        : 'With docker compose, set ANALYZER_HEAVY=1 in .env and re-pull; without compose (Unraid, Portainer, plain docker) switch the analyzer container’s image to ghcr.io/perminder-klair/subwave-analyzer-heavy.';
      if (wantEmb && analyzer.audioEmbeddingAvailable() === false) {
        out.push({
          label: 'audio embeddings',
          status: 'warn',
          detail: 'enabled, but the analyzer can’t produce them',
          hint: `The “sounds-like” audio embeddings need the heavy analyzer (CLAP). You’re on the lean build, so this setting silently does nothing. ${upgradeHint} Or turn the setting off.`,
        });
      }
      if (wantVocal && analyzer.vocalActivityAvailable() === false) {
        out.push({
          label: 'vocal activity',
          status: 'warn',
          detail: 'enabled, but the analyzer can’t produce it',
          hint: `Vocal-range / talk-timing analysis needs the heavy analyzer (Demucs). The lean build can’t, so this setting no-ops. ${upgradeHint} Or turn the setting off.`,
        });
      }
    }
    // Stem cache / stem blends need the same Demucs stack.
    const wantStems = !!s?.audio?.stemCache || !!s?.transitions?.stemBlends;
    if (wantStems && analyzer.vocalActivityAvailable() === false) {
      const upgradeHint = analyzer.backendLabel() === 'local'
        ? 'On the all-in-one image, switch to ghcr.io/perminder-klair/subwave-aio-heavy; on a dev venv, install the heavy Python deps.'
        : 'Set ANALYZER_HEAVY=1 in .env and re-pull, or switch the analyzer container to ghcr.io/perminder-klair/subwave-analyzer-heavy.';
      out.push({
        label: 'stem transitions',
        status: 'warn',
        detail: 'enabled, but the analyzer can’t separate stems',
        hint: `The stem cache and stem-blend transitions need the heavy analyzer (Demucs). The lean build can’t separate, so these settings silently no-op. ${upgradeHint} Or turn them off.`,
      });
    }
    // Coverage, not just capability: stem blends only fire when BOTH tracks of
    // a pair have cached stems, so a station with the feature on and a nearly
    // empty cache hears plain crossfades forever and has nothing to tell it
    // why. Report the real numbers and name the two things that cause it — a
    // backfill that hasn't run yet, or a budget too small to hold the library.
    //
    // Coverage is counted from DISK (stemCache.usage().dirs), not the
    // stems_at stamps: stamps record attempts and keep growing as new tracks
    // analyse while the sweep evicts old dirs, so the stamp count drifts
    // optimistic over time and would eventually mute this warning on exactly
    // the stations that need it. The stamp count rides along in the detail —
    // the gap between the two numbers is itself diagnostic (eviction or
    // failed separations vs a backfill that simply hasn't run).
    //
    // db.isOpen() guard: the library DB opens lazily on the first pick, and
    // the doctor is exactly the tool an operator reaches for when the picker
    // ISN'T running — without the guard, requireDb() would throw and safe()
    // would replace this whole section with a spurious "check failed".
    if (wantStems && analyzer.vocalActivityAvailable() !== false && db.isOpen()) {
      const use = await stemCache.usage();
      const cached = use.dirs;
      const attempted = db.stemsCachedCount();
      const total = db.trackCount();
      const budgetGb = Number(s?.audio?.stemCacheGb) || 15;
      const budgetBytes = budgetGb * 1024 ** 3;
      // Sized off the cache's own measured per-track average once it has one
      // — the fixed 25 MB guess ran ~2x pessimistic in the field (#1257).
      const holds = Math.floor(budgetBytes / use.estTrackBytes);
      // A cache sitting meaningfully over budget means the hourly LRU sweep
      // isn't evicting (#1257: 674 GB standing against a 500 GB budget, with
      // nothing anywhere saying so). Margin allows the normal write-then-sweep
      // overshoot between hourly sweeps without flapping.
      if (use.bytes > budgetBytes + Math.max(budgetBytes * 0.05, 1024 ** 3)) {
        out.push({
          label: 'stem transitions',
          status: 'warn',
          detail: `the stem cache holds ${(use.bytes / 1024 ** 3).toFixed(0)} GB against a ${budgetGb} GB budget`,
          hint: 'The hourly sweep should keep the cache at its budget, so evictions are failing. Check that the controller container can delete under state/stems (it removes what the analyzer wrote — a relocated stems mount with different ownership is the usual cause), and the booth log for "Stem cache" lines.',
        });
      }
      if (total > 0 && cached < total / 2) {
        out.push({
          label: 'stem transitions',
          status: 'warn',
          detail: `only ${cached.toLocaleString('en-GB')} of ${total.toLocaleString('en-GB')} tracks have stems on disk` +
            (attempted > cached ? ` (${attempted.toLocaleString('en-GB')} attempted)` : ''),
          hint: holds < total
            ? `Blends need cached stems on BOTH tracks of a pair, so most seams will fall back to a plain crossfade. The ${budgetGb} GB budget only holds ~${holds.toLocaleString('en-GB')} tracks — raise audio.stemCacheGb in Settings → Transitions to cover more of the library, then let the analysis pass backfill the rest.`
            : 'Blends need cached stems on BOTH tracks of a pair, so most seams will fall back to a plain crossfade until the backfill catches up. Run the analysis pass (it now targets tracks with no cached stems) and this fills in over a few runs.',
        });
      }
    }
    // Stem blends ride the pair-drain scheduling — without it no seam is ever
    // pair-annotated and a blend can never be inserted.
    if (s?.transitions?.stemBlends && s?.transitions?.pairDrain === false) {
      out.push({
        label: 'stem transitions',
        status: 'warn',
        detail: 'stem blends are on but pair-drain scheduling is off',
        hint: 'transitions.stemBlends needs transitions.pairDrain — a blend can only be inserted at a pair-aware drain. Re-enable pairDrain or turn stem blends off.',
      });
    }
  } catch { /* analyzer unavailable — skip */ }

  // --- Broadcast encoder load vs host CPU ---
  // Every extra mount and the hourly archive is a continuous encoder — real CPU.
  // Flag it only when several are on AND the host is already under pressure.
  try {
    const st: NonNullable<StationSettings['stream']> = s?.stream || {};
    const extra: string[] = [];
    if (st.opusEnabled) extra.push('opus');
    if (st.flacEnabled) extra.push('flac');
    if (st.aacEnabled) extra.push('aac');
    // Four encoders, one per rung — counted as such, not as one mount.
    const hls = hlsActive(s);
    if (hls) extra.push('hls ×4');
    if (s?.archive?.enabled) extra.push('hourly archive');
    const encoderCount = 1 + extra.length + (hls ? 3 : 0); // /stream.mp3 always
    const sys = await system.summary();
    const cores = sys.host?.cpus || 0;
    const load1 = Array.isArray(sys.host?.loadavg) ? sys.host.loadavg[0] : 0;
    const perCore = cores > 0 ? load1 / cores : 0;
    const pressured = (cores > 0 && cores <= 2) || perCore > 0.8;
    const heavy = extra.length >= 2;
    out.push({
      label: 'broadcast encoders',
      status: heavy && pressured ? 'warn' : 'ok',
      detail: `${encoderCount} encoder${encoderCount === 1 ? '' : 's'} (mp3${extra.length ? ' + ' + extra.join(' + ') : ''}) · ${cores} cores, load ${load1.toFixed(2)}`,
      hint:
        heavy && pressured
          ? 'Each extra stream mount and the hourly archive is a continuous encoder, and this host is already loaded for its core count. The hourly archive is the single biggest cost — disable mounts you don’t use (Settings → Broadcast) to free CPU for the DJ and TTS.'
          : undefined,
    });
  } catch { /* resources unavailable — skip encoder check */ }

  return out;
}


