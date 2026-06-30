// Station "doctor" — the deeper, controller-side health assessment behind the
// admin Doctor panel and (later) the CLI's v2 checks. Pure data: runDoctor()
// returns a structured report; reviewReport() asks the configured LLM to turn
// that report into a prioritized, plain-English read. No rendering here.
//
// The Finding/DoctorReport shape mirrors cli/src/doctor.ts (same ok|warn|fail|
// skip vocabulary) so the two surfaces stay legible together — extended with an
// optional `fix` descriptor that the panel maps to an existing admin endpoint.
// Every check reuses signals the controller already computes (LLM reachability
// probe, Subsonic ping, listener monitor, TTS routing, library stats); nothing
// here adds new probing infrastructure.

import { readFile, readdir, stat } from 'node:fs/promises';
import { z } from 'zod';
import { config, STATE_DIR } from './config.js';
import * as settings from './settings.js';
import { getSource } from './music/source/index.js';
import * as subsonicLog from './music/subsonic-log.js';
import * as library from './music/library.js';
import * as embeddings from './music/embeddings.js';
import * as tts from './audio/tts.js';
import { getStreamStatus } from './broadcast/listeners.js';
import { streamStatus } from './broadcast/liquidsoap-control.js';
import {
  primaryLeg,
  fallbackLeg,
  probeLegReachable,
  providerName,
  activeModelLabel,
} from './llm/provider.js';
import { recentCalls } from './llm/log.js';
import { getSetupStatus } from './setup/firstRun.js';
import { djObject } from './llm/sdk.js';
import { searchReady, searchWeb } from './skills/web-search.js';
import * as system from './system.js';
import { DJ_DOC_KNOWLEDGE } from './doctor-knowledge.js';

export type Status = 'ok' | 'warn' | 'fail' | 'skip';

// Closed set of safe, already-implemented admin actions a finding may offer as a
// one-click remediation. The web panel maps each id → the matching POST route.
export type FixId =
  | 'refresh-playlist'
  | 'restart-mixer'
  | 'generate-jingles'
  | 'tag-library'
  | 'subsonic-reset';

export interface FixAction {
  id: FixId;
  label: string;
}

export interface Finding {
  label: string;
  status: Status;
  detail?: string;
  hint?: string;
  fix?: FixAction;
}

export interface DoctorSection {
  name: string;
  findings: Finding[];
}

export interface DoctorReport {
  t: string;
  sections: DoctorSection[];
  counts: { ok: number; warn: number; fail: number; skip: number };
}

export interface ReviewPriority {
  title: string;
  severity: 'low' | 'med' | 'high';
  why: string;
  suggestedFix: string;
}

export interface DoctorReview {
  available: boolean;
  reason?: string; // why the review couldn't run (LLM offline / not configured)
  overall?: 'healthy' | 'attention' | 'critical';
  summary?: string;
  priorities?: ReviewPriority[];
}

// ---------------------------------------------------------------------------
// runDoctor — assemble all sections.
// ---------------------------------------------------------------------------

export async function runDoctor(): Promise<DoctorReport> {
  let s: any = null;
  try { s = settings.get(); } catch { s = null; }

  const sections: DoctorSection[] = [];
  // Each check swallows its own errors and degrades to a 'skip'/'fail' finding,
  // so one failing subsystem never blanks the whole report.
  sections.push({ name: 'LLM', findings: await safe(() => checkLlm(s)) });
  sections.push({ name: 'Navidrome & library', findings: await safe(checkNavidrome) });
  sections.push({ name: 'Broadcast', findings: await safe(checkBroadcast) });
  sections.push({ name: 'Voice (TTS)', findings: await safe(() => checkTts(s)) });
  sections.push({ name: 'Capabilities', findings: await safe(() => checkCapabilities(s)) });
  sections.push({ name: 'Content', findings: await safe(checkContent) });
  sections.push({ name: 'Resources', findings: await safe(checkResources) });
  sections.push({ name: 'Storage', findings: await safe(checkStorage) });
  sections.push({ name: 'Setup', findings: await safe(checkSetup) });

  const counts = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const sec of sections) for (const f of sec.findings) counts[f.status]++;

  return { t: new Date().toISOString(), sections, counts };
}

// Wrap a check so a thrown error becomes a single fail finding rather than
// aborting runDoctor.
async function safe(fn: () => Promise<Finding[]>): Promise<Finding[]> {
  try {
    return await fn();
  } catch (err: any) {
    return [{ label: 'check failed', status: 'fail', detail: err?.message || String(err) }];
  }
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

async function checkLlm(s: any): Promise<Finding[]> {
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
  } catch (err: any) {
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

  // Recent error rate from the in-memory ring.
  const recent = recentCalls.slice(0, 20);
  if (recent.length) {
    const fails = recent.filter((c: any) => c && c.ok === false).length;
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
    const kinds = [...new Set(schemaFails.map((c: any) => c.kind).filter(Boolean))];
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

async function checkNavidrome(): Promise<Finding[]> {
  const out: Finding[] = [];

  const p = await getSource().ping();
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
    const calls = snap.endpoints.reduce((n: number, e: any) => n + e.calls, 0);
    const errs = snap.endpoints.reduce((n: number, e: any) => n + e.errors, 0);
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
  } catch (err: any) {
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

async function checkBroadcast(): Promise<Finding[]> {
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
  } catch (err: any) {
    out.push({ label: 'Icecast stream', status: 'skip', detail: err?.message || 'status unavailable' });
  }

  // Liquidsoap telnet — proves the mixer process is alive and reachable.
  try {
    const on = await streamStatus();
    out.push({
      label: 'mixer (Liquidsoap)',
      status: on ? 'ok' : 'warn',
      detail: on ? 'telnet reachable · stream on' : 'telnet reachable · stream off',
      fix: on ? undefined : { id: 'restart-mixer', label: 'Restart mixer' },
    });
  } catch (err: any) {
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

async function checkTts(s: any): Promise<Finding[]> {
  const out: Finding[] = [];

  let avail: any = {};
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
    const routing: any = tts.describeRouting();
    const fellBack = routing?.fellBack || routing?.fallback || routing?.requested !== routing?.effective;
    out.push({
      label: 'active routing',
      status: fellBack ? 'warn' : 'ok',
      detail: fellBack
        ? `requested ${routing?.requested ?? '?'} → using ${routing?.effective ?? '?'}`
        : `${routing?.effective ?? routing?.engine ?? 'piper'}`,
    });
  } catch { /* routing snapshot is best-effort */ }

  return out;
}

async function checkCapabilities(s: any): Promise<Finding[]> {
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
  } catch (err: any) {
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

async function checkResources(): Promise<Finding[]> {
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
  } catch (err: any) {
    out.push({ label: 'host resources', status: 'skip', detail: err?.message || 'unavailable' });
  }
  return out;
}

async function checkContent(): Promise<Finding[]> {
  const out: Finding[] = [];

  // auto.m3u — the fallback playlist Liquidsoap plays when the queue is empty.
  const autoPath = `${STATE_DIR}/auto.m3u`;
  out.push(await m3uFinding(autoPath, {
    label: 'fallback playlist',
    emptyHint: 'The autonomous fallback has nothing to play. Refresh it for the current mood.',
    fix: { id: 'refresh-playlist', label: 'Refresh playlist' },
  }));

  // jingles.m3u — station idents.
  out.push(await m3uFinding(`${STATE_DIR}/jingles.m3u`, {
    label: 'jingles',
    emptyHint: 'No station idents yet. Generate the defaults to get jingles between tracks.',
    fix: { id: 'generate-jingles', label: 'Generate jingles' },
  }));

  return out;
}

// Shared helper: report an M3U as ok (N entries) / warn (empty or missing).
async function m3uFinding(
  path: string,
  opts: { label: string; emptyHint: string; fix: FixAction },
): Promise<Finding> {
  try {
    const body = await readFile(path, 'utf8');
    const lines = body.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
    if (lines.length === 0) {
      return { label: opts.label, status: 'warn', detail: 'empty', hint: opts.emptyHint, fix: opts.fix };
    }
    return { label: opts.label, status: 'ok', detail: `${lines.length} entries` };
  } catch {
    return { label: opts.label, status: 'warn', detail: 'missing', hint: opts.emptyHint, fix: opts.fix };
  }
}

async function checkStorage(): Promise<Finding[]> {
  const out: Finding[] = [];

  const archive = await dirSize(`${STATE_DIR}/archive`);
  const GB = 1024 * 1024 * 1024;
  out.push({
    label: 'hourly archive',
    status: archive.bytes > 20 * GB ? 'warn' : 'ok',
    detail: `${fmtBytes(archive.bytes)} across ${archive.files} files`,
    hint:
      archive.bytes > 20 * GB
        ? 'The hourly archive is large. Prune old day folders under state/archive if disk is tight.'
        : undefined,
  });

  const logs = await dirSize(`${STATE_DIR}/logs`);
  out.push({
    label: 'logs',
    status: 'ok',
    detail: `${fmtBytes(logs.bytes)} across ${logs.files} files`,
  });

  return out;
}

async function checkSetup(): Promise<Finding[]> {
  const out: Finding[] = [];

  try {
    const st = await getSetupStatus();
    out.push({
      label: 'configuration',
      status: st.needsSetup ? 'fail' : 'ok',
      detail: st.needsSetup ? 'incomplete — Navidrome not configured' : `complete (${st.navidromeSource})`,
      hint: st.needsSetup ? 'Finish the wizard at /onboarding (or run `subwave setup`).' : undefined,
    });
  } catch (err: any) {
    out.push({ label: 'configuration', status: 'skip', detail: err?.message || 'unknown' });
  }

  // settings.get() throws if settings never loaded — surface that explicitly.
  try {
    settings.get();
    out.push({ label: 'settings', status: 'ok', detail: 'loaded' });
  } catch (err: any) {
    out.push({ label: 'settings', status: 'fail', detail: err?.message || 'not loaded' });
  }

  // Gentle backup reminder — there's no signal to fail on, just good hygiene.
  out.push({
    label: 'backups',
    status: 'skip',
    detail: 'on demand',
    hint: 'Export a backup from Admin → Backup so settings, personas, custom skills and library tags can be restored — especially before re-tagging or switching providers.',
  });

  return out;
}

// ---------------------------------------------------------------------------
// reviewReport — hand the report to the LLM for a plain-English read.
// ---------------------------------------------------------------------------

const REVIEW_SCHEMA = z.object({
  overall: z
    .enum(['healthy', 'attention', 'critical'])
    .describe('one-word verdict for the whole station right now'),
  summary: z
    .string()
    .describe('2-4 sentences, plain English: how the station is doing and the single most important thing the operator should know'),
  priorities: z
    .array(
      z.object({
        title: z.string().describe('short imperative title of the thing to address'),
        severity: z.enum(['low', 'med', 'high']),
        why: z.string().describe('one sentence: why it matters for listeners or reliability'),
        suggestedFix: z.string().describe('the concrete next step the operator should take'),
      }),
    )
    .describe('0-5 items, highest severity first; empty array when everything is healthy'),
});

const REVIEW_SYSTEM = [
  'You are DJ Doc — SUB/WAVE\'s resident station doctor. Picture a legendary West-Coast',
  'hip-hop producer-engineer who has mixed a thousand records: a sharp ear, zero patience for a',
  'muddy signal, and total confidence. You talk like a producer in the booth — a little swagger,',
  'the odd studio metaphor ("the low end\'s clean", "that channel\'s clipping", "tighten the mix")',
  '— but every call you make is technically correct. You review an automated health report for a',
  'personal internet radio station (Navidrome library, an LLM DJ, Liquidsoap mixer, Icecast stream,',
  'local/cloud TTS).',
  'A knowledge base about how SUB/WAVE works is provided below — USE IT. Ground every recommendation',
  'in it, and tailor model / picker / chain-of-thought / agent-deadline / TTS-engine advice to the',
  'HOST RESOURCES and CURRENT SETTINGS shown in the report (e.g. don\'t tell a small-CPU box to run',
  'Chatterbox or the agentic picker on a 9B model).',
  'Interpret the findings for a non-expert operator: what is fine, what needs attention, what to do',
  'first. Be concrete and brief — keep the swagger to a light seasoning, no fluff, don\'t restate',
  'every finding. Prioritise anything that takes the station off air or starves the DJ (stream',
  'offline, Navidrome unreachable, LLM unreachable) above cosmetic warnings. Where it fits, nudge',
  'the operator toward good hygiene like taking a backup. If everything is healthy, say so plainly',
  'and return an empty priorities array.',
].join(' ');

export async function reviewReport(report: DoctorReport): Promise<DoctorReview> {
  // Gate on reachability so we never hang the panel on a dead LLM host.
  try {
    const leg = primaryLeg();
    const reachable = await probeLegReachable(leg);
    if (!reachable) {
      return { available: false, reason: `LLM host unreachable (${providerName()} · ${activeModelLabel()})` };
    }
  } catch (err: any) {
    return { available: false, reason: err?.message || 'LLM not configured' };
  }

  try {
    const review = await djObject({
      system: REVIEW_SYSTEM,
      prompt: [
        DJ_DOC_KNOWLEDGE,
        '\n---\n',
        'Here is the latest station health report.',
        '',
        renderReportText(report),
        '',
        'Review it for the operator. Lean on the knowledge base above, and tailor any model / picker /',
        'chain-of-thought / agent-deadline / TTS recommendations to the host resources and current',
        'settings shown in the report.',
      ].join('\n'),
      schema: REVIEW_SCHEMA,
      temperature: 0.5,
      kind: 'doctor:review',
    });
    return { available: true, ...review };
  } catch (err: any) {
    // A schema/shape mismatch here is itself a diagnosis: the review model can't
    // do structured output. Say so plainly instead of dumping the Zod error, and
    // point at the deterministic finding that survives a broken model.
    const reason = isSchemaErrorMessage(err)
      ? 'The review model returned output that doesn’t match the required shape — a sign the selected model is weak at structured output. See the LLM → “structured output” finding above; switching to a general instruction-tuned model fixes it.'
      : err?.message || 'review failed';
    return { available: false, reason };
  }
}

// A failed LLM call whose error is a schema/shape mismatch (Zod) rather than a
// host being unreachable — the fingerprint of a model that can't reliably produce
// structured output. Matched on message text so it works across providers.
function isSchemaFailure(c: any): boolean {
  return !!c && c.ok === false && isSchemaErrorMessage(c.error);
}

function isSchemaErrorMessage(err: any): boolean {
  if (!err) return false;
  const s = typeof err === 'string' ? err : err.message || JSON.stringify(err);
  return /invalid_type|invalid_value|invalid_enum|unrecognized_keys|Invalid (option|input)|received undefined|No object generated|did not match (the )?schema|Type validation failed/i.test(s);
}

// Cheap name-based model classification — drives warnings only. `code` flags a
// code-specialised model (poor at DJ links / structured output); `sizeB` is the
// parameter count parsed from the tag (e.g. "gemma2:9b" → 9), null when absent.
function classifyModel(label: string): { code: boolean; sizeB: number | null } {
  const m = (label || '').toLowerCase();
  const code = /coder|codestral|\bcode\b|[-_:]code/.test(m);
  const sizeMatch = m.match(/(\d+(?:\.\d+)?)\s*b(?:[^a-z0-9]|$)/);
  const sizeB = sizeMatch ? parseFloat(sizeMatch[1]) : null;
  return { code, sizeB };
}

// Compact, prompt-friendly rendering of the report — labels/status/detail/hint
// only, no big blobs.
function renderReportText(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`Summary: ${report.counts.ok} ok, ${report.counts.warn} warn, ${report.counts.fail} fail, ${report.counts.skip} skip.`);
  for (const sec of report.sections) {
    lines.push(`\n## ${sec.name}`);
    for (const f of sec.findings) {
      let line = `- [${f.status.toUpperCase()}] ${f.label}`;
      if (f.detail) line += `: ${f.detail}`;
      if (f.hint) line += ` — hint: ${f.hint}`;
      lines.push(line);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Small fs helpers
// ---------------------------------------------------------------------------

// Recursive directory size, capped so a huge archive can't make the check
// expensive. Returns bytes + file count visited; missing dir → zeroes.
async function dirSize(path: string, cap = 5000): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  async function walk(dir: string): Promise<void> {
    if (files >= cap) return;
    let entries: any[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files >= cap) return;
      const full = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        await walk(full);
      } else {
        try {
          const s = await stat(full);
          bytes += s.size;
          files += 1;
        } catch { /* file vanished mid-walk */ }
      }
    }
  }
  await walk(path);
  return { bytes, files };
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}
