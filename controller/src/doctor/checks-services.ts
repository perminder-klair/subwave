// Checks over the external services the station depends on: the LLM provider,
// Navidrome, the broadcast chain and TTS. Each returns findings and never
// throws - doctor.ts's `safe` wrapper is the backstop, not the contract.
//
// Part of the doctor/ split - see ../doctor.ts for the section runner.

import { config } from '../config.js';
import * as subsonic from '../music/source.js';
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
import { recentCalls } from '../llm/log.js';
import { spotifyPool, spotifyClient, receiverDeviceName } from '../music/sources/spotify/source.js';
import { receiverStatus } from '../routes/settings/spotify.js';
import type { Finding, StationSettings } from './types.js';
import { classifyModel, isSchemaFailure } from './util.js';

// Whether the Spotify pool — the station's whole library in spotify mode — holds
// anything. Reads the LAST BUILD rather than forcing one: doctor must not spend
// a rebuild's worth of API calls, and a pool nobody has built yet is not a fault.
function spotifyPoolFinding(): Finding[] {
  const p = spotifyPool().peek();
  if (!p) return [{ label: 'spotify pool', status: 'warn', detail: 'not built yet — it builds on first use' }];
  const summary = `${p.tracks.size} tracks · ${p.albums.size} albums · ${p.playlists.length} playlists`;
  // A rate-limit hold is context, never the verdict: it explains a stalled genre
  // fill and a pool that is not rebuilding, and it clears itself. Severity still
  // follows whether there is music, because an empty pool is dead air whatever
  // the reason.
  const hold = spotifyClient().rateLimitHold();
  const heldMs = hold.msLeft;
  const quota = hold.kind === 'quota';
  const limited = heldMs > 0
    ? ` · ${quota ? 'Spotify quota exhausted' : 'Spotify rate limit'}, ${Math.ceil(heldMs / 1000)}s left`
    : '';
  // Two different refusals, and telling them apart is the difference between
  // "wait a moment" and "something else on this developer account is spending
  // the budget". Since July 2026 the Development Mode quota is counted per
  // ACCOUNT, shared by every app it owns.
  const limitHint = quota
    ? 'This is the developer ACCOUNT quota, not the 30-second rate limit: since July 2026 it is shared by every app on the account. The station stops asking until it clears and resumes on its own. Lower spotify.quota.genresPerHour, or raise spotify.pool.fullWalkHours, if it keeps happening.'
    : 'Development Mode meters a rolling 30s window and cannot be raised (extended quota is organisations-only). The station backs off on its own and resumes when the window clears.';

  if (p.tracks.size === 0) {
    return [{
      label: 'spotify pool',
      status: 'fail',
      detail: `${p.notes.length ? `empty — ${p.notes[0]}` : `empty (${summary})`}${limited}`,
      hint: heldMs > 0 ? limitHint : 'Nothing to play: the mixer\'s emergency loop covers the air. Spotify serves playlist contents only for playlists the connected account owns or collaborates on — check Settings → Music source → Library pool.',
    }];
  }
  if (p.partial) {
    return [{ label: 'spotify pool', status: 'warn', detail: `${summary} · partial — ${p.notes[0] ?? 'a source page failed'}${limited}`, hint: heldMs > 0 ? limitHint : undefined }];
  }
  // Pending genres are enrichment in flight, not a fault — say so at ok.
  if (p.genresPending > 0 || heldMs > 0) {
    return [{
      label: 'spotify pool',
      status: 'ok',
      detail: `${summary} · ${p.genresPending} artists awaiting genres${limited}`,
      hint: heldMs > 0 ? limitHint : undefined,
    }];
  }
  return [{ label: 'spotify pool', status: 'ok', detail: summary }];
}

// Is the Spotify Connect receiver (librespot, in the broadcast container)
// actually there? Nothing checked this before, so BOTH other spotify findings
// went green with a completely dead receiver — the station on its emergency
// loop, the doctor reporting connectivity ok and a full pool.
//
// Three states an operator has to tell apart, only the first of which was
// visible anywhere: not signed in, signed in but not running, and running under
// a name the controller is not looking for. The last two are why this reads the
// live device list rather than trusting `credentialsCached`, which says "signed
// in" whether or not any process exists.
async function spotifyReceiverFinding(): Promise<Finding[]> {
  const label = 'spotify receiver';
  // Where the truth is. Liquidsoap owns the wrapper's stderr and never forwards
  // it, so this file is the only record of WHY — and an empty one is itself a
  // diagnosis: the image has no librespot to run.
  const logHint = 'Why: state/logs/librespot.log in the broadcast container. An EMPTY log there means the image has no librespot — `docker compose build broadcast` (the compose file also names a published upstream image, which does not carry it).';
  let rx: Awaited<ReturnType<typeof receiverStatus>>;
  try {
    rx = await receiverStatus();
  } catch (err: any) {
    return [{ label, status: 'warn', detail: `could not read the receiver's state: ${err?.message ?? err}` }];
  }

  if (!rx.credentialsCached && !rx.tokenValid) {
    return [{
      label,
      status: 'fail',
      detail: rx.tokenPresent ? 'not signed in — its login token has expired' : 'not signed in',
      hint: 'Settings → Music source → Playback → Sign the receiver in, then restart the mixer. This is a SECOND login, separate from Connect Spotify: librespot authenticates as Spotify\'s own desktop client and refuses a Developer-app token.',
    }];
  }

  // Signed in on paper. The device list is the only thing that proves a process.
  try {
    const devices: any = await spotifyClient().getDevices();
    const list: any[] = Array.isArray(devices?.devices) ? devices.devices : [];
    const want = receiverDeviceName().trim().toLowerCase();
    const hit = list.find((d) => String(d?.name ?? '').trim().toLowerCase() === want);
    if (hit) return [{ label, status: 'ok', detail: `"${hit.name}" is registered with Spotify` }];
    return [{
      label,
      status: 'fail',
      detail: `signed in, but "${receiverDeviceName()}" is not among the account's devices (${list.map((d) => d?.name).filter(Boolean).join(', ') || 'none'})`,
      hint: `The receiver is not running, or is registered under another name. ${logHint}`,
    }];
  } catch (err: any) {
    // A rate-limited or unreachable device list says nothing about the receiver.
    return [{ label, status: 'warn', detail: `signed in; could not check the device list: ${err?.message ?? err}` }];
  }
}

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

  // Another active source owns its own connectivity story; the Navidrome
  // creds are simply not in play. (Spotify: the account + Premium check.)
  if (subsonic.activeSourceId() !== 'subsonic') {
    // A rate-limit / quota hold is NOT a connectivity fault, and must never be
    // reported as one. The old finding said `fail` with the hint "add the
    // Spotify client id/secret and press Connect" — which sent operators to a
    // reconnect that invalidates the pool, i.e. straight into a worse state,
    // over a limit that clears itself. spotifyPoolFinding() below already
    // treats a hold as context rather than a verdict; this reads the same way.
    if (subsonic.activeSourceId() === 'spotify') {
      const hold = spotifyClient().rateLimitHold();
      if (hold.msLeft > 0) {
        out.push({
          label: 'spotify connectivity',
          status: 'warn',
          detail: `${hold.kind === 'quota' ? "the developer account's Web API quota is exhausted" : 'Spotify is rate-limiting the station'} — ${Math.ceil(hold.msLeft / 1000)}s left. Playback is unaffected.`,
          hint: 'Nothing to fix and nothing to reconnect: the station stops asking and resumes on its own. Do NOT disconnect or re-enter credentials over this.',
        });
        return out;
      }
    }
    const sp = await subsonic.ping();
    out.push({
      label: `${subsonic.activeSourceId()} connectivity`,
      status: sp.ok ? 'ok' : 'fail',
      detail: sp.reason || (sp.ok ? 'connected' : 'unreachable'),
      hint: sp.ok ? undefined : 'Settings → Music source: add the Spotify client id/secret and press Connect. Playback needs a Premium account.',
    });
    // Connectivity is NOT the same finding as "there is music to play". The
    // /me probe above keeps passing while every catalog call 403s, which is
    // exactly how a station ran for hours on the dead-air guard with a green
    // doctor. Judge the pool separately.
    if (subsonic.activeSourceId() === 'spotify') {
      out.push(...spotifyPoolFinding());
      // "There is music to play" and "something can play it" are also different
      // findings — a dead receiver leaves both of the others green.
      out.push(...(await spotifyReceiverFinding()));
    }
    return out;
  }

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
// The banner polls this from every admin page every ~30s; the cache keeps that
// from becoming a steady drip of `ping` calls (and shields a flapping server).
// Shares subsonic.ping() — the same never-throwing check checkNavidrome() uses
// — so the banner and the Doctor's connectivity finding can never disagree.
//
// THE TTL MUST COMFORTABLY EXCEED THE POLL INTERVAL, which is the whole reason
// it exists. At 20s against a 30s poll it deduplicated nothing: every poll
// found the entry expired and took a fresh reading, so the cache only ever
// coalesced extra TABS inside one window. That was invisible on Navidrome,
// where a ping is a local HTTP call — and expensive once `ping` became the
// FACADE, because on Spotify it is `GET /me` against a rolling 30-second quota:
// ~120 metered requests an hour for as long as any admin page was open, spent
// on a green dot. Five minutes is right for a liveness indicator; the Doctor's
// own run does not come through here (checkNavidrome calls subsonic.ping()
// directly), so a full check is still live, and clearNavidromeCache() below
// keeps a creds change from waiting the TTL out.
let navidromeCache: { at: number; result: { ok: boolean; reason?: string } } | null = null;
const NAVIDROME_TTL_MS = 5 * 60_000;

export async function navidromeConnectivity(): Promise<{
  ok: boolean;
  reason?: string;
  url: string;
  source: string;
  holding?: boolean;
}> {
  const source = subsonic.activeSourceId();
  // A rate-limit / quota hold is not an outage, and the banner this feeds must
  // not tell the operator their music server is down over one. It clears
  // itself, playback is unaffected, and the advice the banner gives for a real
  // outage ("check the connection") is actively harmful here — reconnecting
  // rebuilds the pool.
  if (source === 'spotify') {
    const hold = spotifyClient().rateLimitHold();
    if (hold.msLeft > 0) {
      return {
        ok: true,
        holding: true,
        source,
        reason: `${hold.kind === 'quota' ? "Spotify's developer-account quota is exhausted" : 'Spotify is rate-limiting the station'} — about ${Math.ceil(hold.msLeft / 1000)}s left. Playback is unaffected and it clears on its own.`,
        url: config.navidrome.url,
      };
    }
  }
  const now = Date.now();
  if (!navidromeCache || now - navidromeCache.at > NAVIDROME_TTL_MS) {
    navidromeCache = { at: now, result: await subsonic.ping() };
  }
  return { ...navidromeCache.result, url: config.navidrome.url, source };
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


