// Checks over the external services the station depends on: the LLM provider,
// Navidrome, the broadcast chain and TTS. Each returns findings and never
// throws - doctor.ts's `safe` wrapper is the backstop, not the contract.
//
// Part of the doctor/ split - see ../doctor.ts for the section runner.

import { config } from '../config.js';
import * as subsonic from '../music/subsonic.js';
import * as subsonicLog from '../music/subsonic-log.js';
import * as library from '../music/library.js';
import * as embeddings from '../music/embeddings.js';
import * as tts from '../audio/tts.js';
import { getStreamStatus } from '../broadcast/listeners.js';
import { streamStatusFresh } from '../broadcast/liquidsoap-control.js';
import {
  primaryLeg,
  fallbackLeg,
  probeLegReachable,
  providerName,
  activeModelLabel,
} from '../llm/provider.js';
import { recentCalls, generationHealthSnapshot } from '../llm/log.js';
import type { Finding, StationSettings } from './types.js';
import { classifyModel, isSchemaFailure } from './util.js';

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export async function checkLlm(s: StationSettings | null): Promise<Finding[]> {
  const out: Finding[] = [];

  // Primary leg. probeLegReachable returns true for cloud providers (no cheap
  // probe) and only false on a connection failure for local hosts.
  try {
    const leg = primaryLeg();
    const ok = await probeLegReachable(leg);
    out.push({
      label: 'provider',
      status: ok ? 'ok' : 'fail',
      detail: `${providerName()} · ${activeModelLabel()}${ok ? ' · reachable' : ' · unreachable'}`,
      hint: ok
        ? undefined
        : 'Without the LLM the DJ falls back to a stateless picker and skips spoken links. Check the provider, model and host in Settings → LLM.',
    });
  } catch (err) {
    out.push({
      label: 'provider',
      status: 'fail',
      detail: err?.message || 'not configured',
      hint: 'Pick a provider + model in Settings → LLM.',
    });
  }

  // Fallback leg (optional).
  try {
    const fb = fallbackLeg();
    if (fb) {
      const ok = await probeLegReachable(fb);
      out.push({
        label: 'fallback',
        status: ok ? 'ok' : 'warn',
        detail: ok ? 'configured · reachable' : 'configured · unreachable',
      });
    } else {
      out.push({ label: 'fallback', status: 'skip', detail: 'none configured (optional)' });
    }
  } catch { /* fallback is best-effort */ }

  // Reachability cannot diagnose a provider whose generation slot is stuck.
  // Keep this finding independent of probes and cached/LLM-generated reviews.
  const generation = generationHealthSnapshot();
  out.push({
    label: 'generation health',
    status: generation.status === 'fail' ? 'fail' : generation.status === 'idle' ? 'skip' : 'ok',
    detail: `${generation.inFlightCount} client-observed in-flight generation(s) · oldest age ${generation.oldestInFlightAgeMs == null ? 'none' : `${Math.floor(generation.oldestInFlightAgeMs)}ms`} · ${generation.status} · process-local, not provider queue depth`,
    hint: generation.status === 'fail'
      ? 'An observed generation is stale or recently timed out. Check the provider and requestTimeoutMs; client abort does not guarantee release of the remote inference slot. /doctor/llm has live target details.'
      : generation.status === 'idle' ? 'No observed generation failure; endpoint capacity is not measured.' : undefined,
  });

  // Recent error rate from the in-memory ring.
  const recent = recentCalls.slice(0, 20);
  if (recent.length) {
    const fails = recent.filter((c) => c && c.ok === false).length;
    const rate = Math.round((fails / recent.length) * 100);
    out.push({
      label: 'recent calls',
      status: rate === 0 ? 'ok' : rate < 30 ? 'warn' : 'fail',
      detail: `${fails}/${recent.length} failed (${rate}%)`,
      hint:
        rate >= 30
          ? 'High failure rate. Confirm the model is loaded and the host is responsive (Debug → recent LLM calls has the errors).'
          : undefined,
    });
  } else {
    out.push({ label: 'recent calls', status: 'skip', detail: 'no calls yet' });
  }

  // Structured-output health — the silent failure mode behind "the model
  // responds but features quietly break". djObject calls (DJ Doc's own AI review,
  // the request matcher, the pool picker, the library tagger) need the model to
  // emit JSON matching a strict shape; a weak model returns the wrong shape, the
  // call fails Zod validation and the feature degrades or falls back unnoticed.
  // We catch it deterministically here precisely because a model this broken ALSO
  // breaks the AI review that would otherwise explain it to the operator.
  const schemaFails = recentCalls.filter(isSchemaFailure);
  if (schemaFails.length) {
    const kinds = [...new Set(schemaFails.map((c) => c.kind).filter(Boolean))];
    out.push({
      label: 'structured output',
      status: schemaFails.length >= 3 ? 'fail' : 'warn',
      detail: `${schemaFails.length} schema-validation failure(s)${kinds.length ? ` · ${kinds.join(', ')}` : ''}`,
      hint:
        'The model is returning JSON that does not match the required shape, so these features fall back or go silent (DJ Doc’s own AI review is one of them). It’s the classic sign of a model that’s weak at schema-constrained output — usually a code-specialised or very small model. Switch Settings → LLM to a general instruction-tuned model (a ~12B+ local or a capable cloud model), and try turning reasoning OFF — “thinking” output can corrupt the JSON.',
    });
  }

  // Model class — weigh the chosen model's *name* against how it's being used.
  // Heuristic only (name-based), so it never fails, only warns: a code-specialised
  // model is tuned for programming rather than DJ links / structured picks, and a
  // small model paired with the agentic picker tends to time out into the pool.
  const cls = classifyModel(activeModelLabel());
  if (cls.code) {
    out.push({
      label: 'model class',
      status: 'warn',
      detail: `${activeModelLabel()} looks code-specialised`,
      hint: 'Code models are tuned for programming, not natural-language DJ links or schema-constrained JSON — they tend to write stiff intros and fail structured picks (the request matcher, pool picker and this very report). Prefer a general instruction-tuned model in Settings → LLM.',
    });
  } else if (cls.sizeB !== null && cls.sizeB < 11 && s?.llm?.pickerAgent !== false) {
    out.push({
      label: 'model class',
      status: 'warn',
      detail: `~${cls.sizeB}B model with the agentic picker on`,
      hint: 'The agentic picker wants a ~12B-class (or good cloud) model; smaller models often time out into the pool fallback or fail structured picks. Either pick a larger model, or turn the agentic picker OFF (Settings → LLM) to use the simpler, more forgiving pool picker.',
    });
  }

  // Picker agent toggle — off is valid (stateless picker) but worth surfacing.
  // DJ Doc weighs this against the model size + host resources in its review.
  out.push({
    label: 'picker agent',
    status: s?.llm?.pickerAgent === false ? 'warn' : 'ok',
    detail: s?.llm?.pickerAgent === false ? 'off — stateless pool picker' : 'on — session DJ agent (wants ~12B+ / good cloud model)',
  });

  // Chain-of-thought (reasoning) — on costs latency + tokens; only worth it on a
  // capable model where link quality beats speed. Surfaced so DJ Doc can advise.
  out.push({
    label: 'chain-of-thought',
    status: 'ok',
    detail: s?.llm?.reasoning ? 'reasoning ON (thinking models; slower, pricier)' : 'reasoning OFF (faster, cheaper — good for small/local models)',
  });

  // Agent deadline — the wall-clock budget before the agentic picker falls back
  // to the pool. Reasoning/cloud models routinely need 20–40s.
  const deadlineMs = Number(s?.llm?.agentTimeoutMs);
  if (Number.isFinite(deadlineMs) && deadlineMs > 0) {
    out.push({
      label: 'agent deadline',
      status: 'ok',
      detail: `${Math.round(deadlineMs / 1000)}s before falling back to the pool`,
      hint: deadlineMs < 20000
        ? 'Tight — reasoning-heavy or cloud models routinely need 20–40s, so the agent may keep falling back. Raise it if you run a slow model.'
        : undefined,
    });
  }

  return out;
}

export async function checkNavidrome(): Promise<Finding[]> {
  const out: Finding[] = [];

  const p = await subsonic.ping();
  out.push({
    label: 'connectivity',
    status: p.ok ? 'ok' : 'fail',
    detail: p.ok ? `${config.navidrome.url} · authenticated` : p.reason || 'unreachable',
    hint: p.ok
      ? undefined
      : 'The picker has no music source without Navidrome. Check the URL / username / password in setup, and that Navidrome is up.',
  });

  // Recent call error rate across all endpoints.
  try {
    const snap = subsonicLog.snapshot();
    const calls = snap.endpoints.reduce((n: number, e) => n + e.calls, 0);
    const errs = snap.endpoints.reduce((n: number, e) => n + e.errors, 0);
    if (calls > 0) {
      const rate = Math.round((errs / calls) * 100);
      out.push({
        label: 'call errors',
        status: rate === 0 ? 'ok' : rate < 10 ? 'warn' : 'fail',
        detail: `${errs}/${calls} calls errored (${rate}%)`,
        fix: rate > 0 ? { id: 'subsonic-reset', label: 'Reset stats' } : undefined,
      });
    } else {
      out.push({ label: 'call errors', status: 'skip', detail: 'no calls yet' });
    }
  } catch { /* tracker is best-effort */ }

  // Mood-tag coverage — the picker leans on these tags to match the vibe.
  try {
    await library.load();
    const st = library.stats();
    out.push({
      label: 'mood-tag coverage',
      status: st.total > 0 ? 'ok' : 'warn',
      detail:
        st.total > 0
          ? `${st.total} tracks tagged · ${st.distinctArtists} artists`
          : 'no tracks tagged yet',
      hint:
        st.total > 0
          ? undefined
          : 'The picker matches tracks to the time-of-day / weather mood via these tags. Tag the library so it has something to work with.',
      fix: st.total === 0 ? { id: 'tag-library', label: 'Tag library' } : undefined,
    });
  } catch (err) {
    out.push({ label: 'mood-tag coverage', status: 'skip', detail: err?.message || 'library unavailable' });
  }

  // Embedding model perf advisory — a heavy LOCAL embedding model (bge-m3,
  // *-large) is the quiet cause of slow re-embeds + Ollama RAM thrash on a
  // CPU/NAS box. Deterministic + name-based (no probe), so it only ever warns.
  try {
    const adv = embeddings.embeddingPerfAdvisory();
    const flag = adv.heavy && adv.local;
    out.push({
      label: 'embedding model',
      status: flag ? 'warn' : 'ok',
      detail: `${adv.provider}:${adv.model}${flag ? ' · heavy for a local host' : ''}`,
      hint: flag
        ? 'This is a large local embedding model — roughly 3–4× the size and 2–3× slower per track than the default nomic-embed-text, with bigger vectors (slower KNN, more RAM). On a CPU / NAS host it dominates re-embed time and can thrash Ollama when RAM is tight (it reloads the model between calls). Unless you specifically need its multilingual / long-context quality, switch Settings → Library tagger → Embedding to nomic-embed-text, then re-embed (Library → Maintenance → Re-embed all tracks).'
        : undefined,
    });
  } catch { /* embedding cfg unavailable — skip silently */ }

  return out;
}

// Cached live-config Navidrome connectivity for the always-on admin banner.
// The banner polls this from every admin page every ~30s; a short cache keeps
// that from becoming a steady drip of Subsonic `ping` calls (and shields a
// flapping Navidrome). Shares subsonic.ping() — the same never-throwing check
// checkNavidrome() uses — so the banner and the Doctor's connectivity finding
// can never disagree.
let navidromeCache: { at: number; result: { ok: boolean; reason?: string } } | null = null;
const NAVIDROME_TTL_MS = 20_000;

export async function navidromeConnectivity(): Promise<{
  ok: boolean;
  reason?: string;
  url: string;
}> {
  const now = Date.now();
  if (!navidromeCache || now - navidromeCache.at > NAVIDROME_TTL_MS) {
    navidromeCache = { at: now, result: await subsonic.ping() };
  }
  return { ...navidromeCache.result, url: config.navidrome.url };
}

// Drop the cached ping so the banner/Doctor re-probe immediately — called when
// the admin saves new Navidrome creds, where a stale "down" result would keep
// the red banner up for the TTL even though the fix just landed.
export function clearNavidromeCache() {
  navidromeCache = null;
}

export async function checkBroadcast(): Promise<Finding[]> {
  const out: Finding[] = [];

  // Icecast — is anything actually being served, and to whom.
  try {
    const st = getStreamStatus();
    out.push({
      label: 'Icecast stream',
      status: st.online ? 'ok' : 'fail',
      detail: st.online
        ? `online · ${st.listeners?.current ?? 0} listening · ${st.bitrate ?? '?'}kbps`
        : 'offline — nothing on /stream.mp3',
      hint: st.online
        ? undefined
        : 'Liquidsoap may have dropped its Icecast connection. A mixer restart reconnects it.',
      fix: st.online ? undefined : { id: 'restart-mixer', label: 'Restart mixer' },
    });
  } catch (err) {
    out.push({ label: 'Icecast stream', status: 'skip', detail: err?.message || 'status unavailable' });
  }

  // Liquidsoap telnet — proves the mixer process is alive and reachable. Reads
  // FRESH, never the /settings badge's cached figure: "proves" is the whole
  // contract here, and a cached reading would let Doctor report a dead mixer as
  // reachable. Doctor is operator-triggered, so the extra connection is rare.
  try {
    const on = await streamStatusFresh();
    out.push({
      label: 'mixer (Liquidsoap)',
      status: on ? 'ok' : 'warn',
      detail: on ? 'telnet reachable · stream on' : 'telnet reachable · stream off',
      fix: on ? undefined : { id: 'restart-mixer', label: 'Restart mixer' },
    });
  } catch (err) {
    out.push({
      label: 'mixer (Liquidsoap)',
      status: 'fail',
      detail: `telnet unreachable: ${err?.message || 'no response'}`,
      hint: 'The mixer process may be down or restarting. Check broadcast logs.',
      fix: { id: 'restart-mixer', label: 'Restart mixer' },
    });
  }

  return out;
}

export async function checkTts(s: StationSettings | null): Promise<Finding[]> {
  const out: Finding[] = [];

  let avail: Record<string, unknown> = {};
  try { avail = tts.availableEngines(); } catch { avail = {}; }

  // Which engines the operator wants vs. which are actually available. A
  // configured-but-unavailable engine silently falls back to Piper.
  const wanted = new Set<string>();
  const def = s?.tts?.defaultEngine;
  if (def) wanted.add(def);
  for (const v of Object.values(s?.tts?.byKind || {})) {
    if (typeof v === 'string' && v) wanted.add(v);
  }
  if (wanted.size === 0) wanted.add('piper');

  const unavailable = [...wanted].filter((e) => avail[e] === false);
  out.push({
    label: 'configured engines',
    status: unavailable.length === 0 ? 'ok' : 'warn',
    detail:
      unavailable.length === 0
        ? `${[...wanted].join(', ')} — available`
        : `unavailable: ${unavailable.join(', ')} (will fall back to Piper)`,
    hint:
      unavailable.length === 0
        ? undefined
        : 'A configured voice engine is unavailable, so the DJ speaks in the Piper fallback voice. Enable the engine (e.g. the tts-heavy profile / cloud key) or pick an available one in Settings.',
  });

  // Is the current persona's voice silently routing through a fallback?
  try {
    const { spoken } = tts.describeRouting();
    out.push({
      label: 'active routing',
      status: spoken.fellBack ? 'warn' : 'ok',
      detail: spoken.fellBack
        ? `requested ${spoken.requested ?? '?'} → using ${spoken.engine ?? '?'}`
        : `${spoken.engine ?? 'piper'}`,
    });
  } catch { /* routing snapshot is best-effort */ }

  return out;
}


