// Segment director. segmentTick() (the 5-minute scheduler.skillsTick) picks
// one eligible capability, gathers its source data in code, then asks the
// model whether that one between-track segment is worth airing. It writes ONE
// spoken line or stays silent. It is deliberately NOT given the track-pick
// session history, which derails small models into reasoning about music; its
// anti-repeat context is queue.getDjRecap().
//
// `runCapability()` is the /dj/skill manual override: the same direct path,
// forced to one capability with every automatic gate bypassed. The capability
// registry comes from skills/loader.js.
//
// Guard rails the autonomous tick cannot talk its way past (the operator
// override bypasses all of them): per-kind cooldown from SKILL.md, a
// frequency-derived floor on the gap between ANY two segments, disabled or
// persona-unowned capabilities, and window/provider gating.

import { z } from 'zod';
import { queue } from '../broadcast/queue.js';
import * as settings from '../settings.js';
import { djObject, modelTolerant } from '../llm/sdk.js';
import { buildContextLines, CONTEXT_FIELDS, lengthMode, lengthPhrase } from '../llm/dj.js';
import { fetchSegmentData, dataBlock } from '../llm/segment-tools.js';
import { recordCuriosity, recentAiredCuriosity } from './curiosity.js';
import { loadedCapabilities } from './loader.js';
import { skillEligible } from './eligibility.js';
import { requiresGrounding, standDownReason } from './abstain-policy.js';
import { runCohostedCapability } from './cohosted.js';
import * as sfx from '../broadcast/sfx.js';

// dataBlock lives in llm/segment-tools.js so the co-hosted pool path can share
// it without an import cycle; re-exported here for llm-bench's existing path.
export { dataBlock };

// Every skill loaded from state/skills, built-in and operator-dropped alike, on
// one footing. The autonomous tick, runCapability, skillCatalog and the admin
// toggles all iterate THIS. Read live so a rescan takes effect at once.
function allCapabilities() {
  return loadedCapabilities();
}

// Default per-skill context profile: every "right now" field EXCEPT weather.
// A capability sees weather only when it explicitly asks (#471).
const DEFAULT_SEGMENT_CONTEXT = (CONTEXT_FIELDS as readonly string[]).filter(f => f !== 'weather');

// Context fields for one capability's situation block. cap.contextFields may be
// an array or a comma-string (straight from SKILL.md frontmatter); absent or
// empty means the default profile.
export function effectiveContextFields(cap: { contextFields?: unknown } | null | undefined): string[] {
  const raw = cap?.contextFields;
  if (raw == null) return DEFAULT_SEGMENT_CONTEXT;
  const list = Array.isArray(raw)
    ? raw.map((s: unknown) => String(s).trim()).filter(Boolean)
    : String(raw).split(',').map(s => s.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_SEGMENT_CONTEXT;
}


// Operator-override schema: the kind is already known, so only the spoken line
// comes back. `mayAbstain` (decided by skills/abstain-policy.ts) adds the same
// reason-then-decide pair, so a skill speaking from fetched data can say "that
// data was unusable" rather than invent a line (#1412). On a run that can't
// abstain the field is ABSENT, not false: offering a silence token to a segment
// the operator explicitly asked for is a new way for an explicit action to
// produce nothing.
export function forcedSchema({ mayAbstain = false }: { mayAbstain?: boolean } = {}) {
  const line = {
    text: z.string().describe(`the spoken line in the DJ voice — ${lengthPhrase('segment')}`),
    sfx: z.string().nullable().describe('the exact name of one sound effect from the catalogue in the system prompt to play under this line, or null for no effect'),
  };
  if (!mayAbstain) return modelTolerant(z.object(line));
  // Same field order as segmentSchema: reason, air, then the line.
  return modelTolerant(z.object({
    reason: z.string().describe('one short internal sentence on why this segment (or why you are standing down) — never shown to the listener; write this BEFORE the line'),
    air: z.boolean().describe('true to air the line; false ONLY when the source data you were given is empty, or is about something other than what this segment covers — standing down beats inventing'),
    ...line,
  }));
}

// Optional sound-effects block for the system prompt. '' when the library is
// empty, so the feature stays invisible to the agent.
function sfxBlock(sfxCatalog) {
  if (!sfxCatalog || !sfxCatalog.length) return '';
  const list = sfxCatalog.map((s) => {
    const dur = s.durationSec ? ` (~${s.durationSec}s)` : '';
    return `- ${s.name}${dur}: ${s.description}`;
  }).join('\n');
  return `

SOUND EFFECTS: you may optionally play ONE sound effect underneath your voice for this segment. Use one only when it genuinely sharpens the line — most segments need none, and an effect on every break gets old fast. Set "sfx" to the exact name of an effect below, or null:
${list}`;
}

let tickBusy = false;
const lastFired = new Map<string, number>(); // kind → ms timestamp of last aired segment
const lastUnavailable = new Map<string, number>(); // kind → ms timestamp of last unusable pool-mode fetch

// An unavailable source shouldn't retry on the very next 5-minute tick, nor
// inherit a multi-hour on-air cooldown when the next track may change its
// answer. Capped at 15 min, and a shorter operator cooldown wins.
const UNAVAILABLE_RETRY_BACKOFF_MS = 15 * 60 * 1000;
function unavailableRetryBackoffMs(cap: { cooldownMs?: unknown }): number {
  const cooldownMs = Number(cap.cooldownMs);
  if (!Number.isFinite(cooldownMs) || cooldownMs < 0) return UNAVAILABLE_RETRY_BACKOFF_MS;
  return Math.min(cooldownMs, UNAVAILABLE_RETRY_BACKOFF_MS);
}

// Dedup memory carried across ticks, passed straight into the segment tools.
// Curiosity dedup is NOT here: it lives in the durable ledger in
// skills/curiosity.js (#577) so it survives a restart.
interface SegmentState {
  seenHeadlines: Set<string>;
  // Burn-on-read memory for the generic feed tool (skills/feed.ts), keyed by
  // kind so two feed skills can't suppress each other's items.
  feedSeen: Map<string, Set<string>>;
  lastWeatherCondition: string | null;
  lastSearchedArtist: string | null;
  lastAnySegment: number;
}

const segmentState: SegmentState = {
  seenHeadlines: new Set<string>(),
  feedSeen: new Map<string, Set<string>>(),
  lastWeatherCondition: null,
  lastSearchedArtist: null,
  lastAnySegment: 0,
};

// Minimum gap between ANY two segments, by station frequency. Infinity for
// silent: the auto tick never airs (forced runs bypass this).
function frequencyFloorMs(freq: string) {
  if (freq === 'silent') return Infinity;
  if (freq === 'quiet') return 30 * 60 * 1000;
  if (freq === 'chatty') return 8 * 60 * 1000;
  if (freq === 'aggressive') return 0;
  return 15 * 60 * 1000; // moderate
}

// Capabilities on offer this tick: enabled, owned by the on-air persona,
// off-cooldown, and in-window.
function availableCapabilities(ctx, now: Date) {
  const s = settings.get();
  const enabled = s.skills?.enabled || {};
  const { host: persona, guests } = settings.getOnAirRoster(now);
  const out: ReturnType<typeof allCapabilities> = [];
  for (const cap of allCapabilities()) {
    // Enabled + host-owned + roster-compatible. In skills/eligibility.ts
    // because the cron timer owes the same answers and reaches runCapability()
    // without passing through here.
    if (!skillEligible({
      seeded: cap.seeded,
      skill: cap.skill,
      enabled,
      personaSkills: persona?.skills,
      requiresCohosts: !!cap.cohosts,
      hasCohosts: !!persona && guests.length > 0,
    }).allowed) continue;
    // cronOnly withholds the skill from the director entirely: it fires only
    // from its dedicated cron, which calls runCapability() directly.
    if (cap.cronOnly) continue;
    if (now.getTime() - (lastFired.get(cap.kind) || 0) < cap.cooldownMs) continue;
    if (now.getTime() - (lastUnavailable.get(cap.kind) || 0) < unavailableRetryBackoffMs(cap)) continue;
    // Custom skills opt into commute-hours-only firing via `window: commute`
    // in their SKILL.md frontmatter.
    if (cap.window === 'commute' && !ctx.clock?.isCommute) continue;
    if (cap.ready && !cap.ready()) continue;
    out.push(cap);
  }
  return out;
}

// 'silent' never reaches the auto tick (the frequency floor blocks it); a
// forced run treats it like quiet.
function stationTone(freq: string) {
  return freq === 'quiet' || freq === 'silent'
    ? 'This is a quiet station — silence is your default.'
    : freq === 'aggressive'
      ? 'This is a lively station — frequent presence welcome, never filler.'
      : freq === 'chatty'
        ? 'This is a talkative station — a good segment is usually welcome, but never filler.'
        : 'This is a measured station — speak only when there is something worth saying.';
}

// Wall-clock ceiling for one director run, resolved live. Same source and
// default as the picker's agentDeadline.
function segmentDeadline(): number {
  return settings.get().llm?.agentTimeoutMs ?? 45000;
}

// The situation handed to the model: what is on air plus
// queue.getDjRecap(), never the track-pick session history.
export function buildSituation(ctx, { forced = false, contextFields, recentCuriosity }: { forced?: boolean; contextFields?: string[]; recentCuriosity?: string[] } = {}) {
  const lines = ['The current moment:'];
  const ctxLines = buildContextLines(ctx, { contextFields });
  if (ctxLines.length) lines.push(...ctxLines);
  const cur = queue.current?.track;
  if (cur) lines.push(`On air now: "${cur.title}" by ${cur.artist || 'unknown'}`);
  // Scale the recap cap with the persona's verbosity: at the default 140 chars
  // a long persona's segment is cut after its first sentence, hiding a repeated
  // topic from the anti-repeat instruction.
  const RECAP_CHARS: Record<string, number> = { extended: 360, storyteller: 520 };
  const recap = queue.getDjRecap({ maxChars: RECAP_CHARS[lengthMode()] ?? 140 });
  if (recap) {
    lines.push(`\nWhat you have already said on air recently (do NOT repeat these topics or phrasing):\n${recap}`);
  }
  // Durable curiosity history (#577): with the Wikipedia pool exhausted the
  // agent falls back to free generation, which has no memory of what it aired
  // and repeats the same factoid, sometimes reworded.
  if (recentCuriosity && recentCuriosity.length) {
    const list = recentCuriosity.map(t => `- ${t}`).join('\n');
    lines.push(`\nCuriosity topics already aired in the last few days (openings shown; if you air a curiosity segment, pick a genuinely different subject — do NOT revisit any of these, even reworded):\n${list}`);
  }
  lines.push(forced
    ? '\nWrite the segment the operator has asked for now.'
    : '\nDecide now: air one segment, or stay silent.');
  return lines.join('\n');
}

function buildCohostedSituation(ctx, cap, { forced = false, brief = null }: { forced?: boolean; brief?: string | null } = {}) {
  const recentCuriosity = cap.kind === 'curiosity' ? recentAiredCuriosity() : undefined;
  let situation = buildSituation(ctx, { forced, contextFields: effectiveContextFields(cap), recentCuriosity });
  const openers = queue.getRecentOpeners();
  if (openers.length) situation += `\n\nRecent opening words (start the first contribution differently): ${openers.join(' | ')}`;
  if (brief) situation += `\n\n${brief}`;
  return situation;
}

// The direct director picks the capability, calls its data provider in code,
// then inlines the result into one structured-output request. The model still
// decides whether to air it, but never decides which provider to call.

// Which capability the simple path airs. Weather wins when the condition
// actually changed (the one segment with a hard freshness signal) and is dropped
// entirely when it hasn't; otherwise the least-recently-aired capability, random
// among ties so the rotation spreads across the catalogue.
export function chooseCapability(caps, ctx) {
  const condition = ctx.weather?.condition || null;
  const weatherChanged = !!condition && condition !== segmentState.lastWeatherCondition;
  const pool = caps.filter(c => c.kind !== 'weather' || weatherChanged);
  if (!pool.length) return null;
  if (weatherChanged) {
    const weather = pool.find(c => c.kind === 'weather');
    if (weather) return weather;
  }
  let best: ReturnType<typeof allCapabilities> = [];
  let bestAt = Infinity;
  for (const c of pool) {
    const at = lastFired.get(c.kind) || 0;
    if (at < bestAt) { bestAt = at; best = [c]; }
    else if (at === bestAt) best.push(c);
  }
  return best[Math.floor(Math.random() * best.length)];
}

// Same decision surface as segmentSchema minus `kind` (code already chose it)
// and the nested object (djObject's own repair layers cover a flat shape).
export function simpleSegmentSchema() {
  return modelTolerant(z.object({
    reason: z.string().describe('one short internal sentence on why this segment (or why silent) — never shown to the listener; write this BEFORE deciding'),
    air: z.boolean().describe('true to air this segment now, false to stay silent — silence is a perfectly good answer when the data is dull, stale, unchanged, or not worth a listener\'s attention'),
    text: z.string().describe(`the spoken line in the DJ voice — ${lengthPhrase('segment')}; empty string when air is false`),
    sfx: z.string().nullable().describe('the exact name of one sound effect from the catalogue in the system prompt to play under this line, or null for no effect (null is usually right)'),
  }));
}

export function simpleSystem(persona, cap, freq: string, sfxCatalog) {
  return `${settings.agentPersonaPreamble(persona)}

Your job: decide whether to air ONE between-track "${cap.kind}" segment, or stay silent. You are NOT choosing music. ${stationTone(freq)}

${cap.desc}${sfxBlock(sfxCatalog)}${settings.agentLanguageReminder(persona, 'the "text" line')}`;
}

// Wall-clock guard for the simple path's single djObject call: djObject has no
// deadline of its own, and a grammar-constrained model can ramble inside an
// unbounded string field all the way to the output-token cap (~380s observed).
// The abort turns that into a bounded failure; the tick treats a throw as
// silence.
async function deadlinedSegmentObject(args: Record<string, unknown>) {
  const ac = new AbortController();
  const timer = setTimeout(
    () => ac.abort(new Error(`segment call exceeded ${segmentDeadline()}ms deadline`)),
    segmentDeadline(),
  );
  try {
    return await djObject({ ...args, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

// One tick of the direct path: choose, fetch, and — only when the source is
// usable or the skill permits free generation — one djObject call. Returns the
// shape segmentTick consumes, seg null for silence. Unusable
// data is silence with no model call at all.
async function runSimpleDirector(ctx, { caps, speaker, freq, sfxCatalog }) {
  const cap = chooseCapability(caps, ctx);
  if (!cap) return { seg: null, exchange: null, reason: 'nothing fresh to say' };
  if (cap.cohosts) {
    const { host, guests } = settings.getOnAirRoster();
    if (!host || !guests.length) return { seg: null, exchange: null, reason: 'requires a co-hosted show' };
    const result = await runCohostedCapability({
      capability: cap, host, guests, context: ctx,
      situation: buildCohostedSituation(ctx, cap),
      segmentState, forced: false,
    });
    if (result.aired) lastUnavailable.delete(cap.kind);
    else lastUnavailable.set(cap.kind, Date.now());
    return {
      seg: null,
      exchange: result.aired ? { kind: cap.kind, lines: result.lines || [] } : null,
      reason: result.reason || undefined,
      skippedBeforeLlm: undefined,
    };
  }
  const data = await fetchSegmentData(cap, ctx, segmentState);
  const blocked = standDownReason(cap, data);
  if (blocked || data?.error) {
    lastUnavailable.set(cap.kind, Date.now());
    return {
      seg: null,
      exchange: null,
      reason: blocked || `${cap.kind} data fetch failed (${data.error})`,
      skippedBeforeLlm: cap.kind,
    };
  }
  lastUnavailable.delete(cap.kind);
  const recentCuriosity = cap.kind === 'curiosity' ? recentAiredCuriosity() : undefined;
  const out = await deadlinedSegmentObject({
    system: simpleSystem(speaker, cap, freq, sfxCatalog),
    prompt: buildSituation(ctx, { contextFields: effectiveContextFields(cap), recentCuriosity }) + dataBlock(data),
    schema: simpleSegmentSchema(),
    temperature: 0.9,
    kind: 'generateSegment',
  });
  const text = out?.air ? String(out?.text || '').trim() : '';
  if (!text) return { seg: null, exchange: null, reason: out?.reason || 'nothing to add' };
  return { seg: { kind: cap.kind, text, sfx: out?.sfx ?? null }, exchange: null, reason: out?.reason };
}

// Called by the scheduler's 5-minute cron. Picks at most one segment to air,
// or stays silent. Never throws — failures are logged and the tick ends.
export async function segmentTick(ctx) {
  if (tickBusy) return;

  const now = new Date();
  // Cadence and capability gating key off the HOST persona (stable per show);
  // only the VOICE rotates. What is on offer and how often the station talks
  // never depends on who won the mic.
  const persona = settings.getEffectivePersona(now);
  const speaker = settings.pickOnAirSpeaker(now);
  const freq = settings.effectiveFrequency(persona);

  // Floor on the gap between any two spoken breaks. lastAnySegment sees only
  // what this director aired, but the scheduler's idents and hourly checks share
  // the voice and land on this tick, so without queue's view the DJ could talk
  // twice in a minute (#310). Narrowed to the wall-clock talkers on purpose:
  // track-tied links/intros fire every few tracks and would mute the director
  // outright under a 15-minute floor.
  const lastSpoke = Math.max(
    segmentState.lastAnySegment,
    queue.getLastVoiceAt(['station-id', 'hourly-check', 'handoff', 'banter']),
  );
  if (now.getTime() - lastSpoke < frequencyFloorMs(freq)) return;

  const caps = availableCapabilities(ctx, now);
  if (caps.length === 0) return;

  // Weather alone and unchanged is provably nothing to say; skip the LLM call.
  if (caps.length === 1 && caps[0].kind === 'weather'
      && ctx.weather?.condition && ctx.weather.condition === segmentState.lastWeatherCondition) {
    return;
  }

  tickBusy = true;
  try {
    // Empty catalogue when SFX are disabled — no segment is offered effects.
    const sfxCatalog = settings.get().sfx?.enabled === false ? [] : await sfx.catalog();

    const { seg, exchange, reason: silentReason, skippedBeforeLlm } =
      await runSimpleDirector(ctx, { caps, speaker, freq, sfxCatalog });

    if (exchange) {
      const aired = await queue.announceExchange(exchange.lines, exchange.kind);
      if (!aired) throw new Error(`co-hosted skill "${exchange.kind}" failed to render`);
      lastFired.set(exchange.kind, Date.now());
      segmentState.lastAnySegment = Date.now();
      if (exchange.kind === 'weather' && ctx.weather?.condition) segmentState.lastWeatherCondition = ctx.weather.condition;
      if (exchange.kind === 'curiosity') recordCuriosity(exchange.lines.map((line) => line.text).join(' '), { aired: true });
      return;
    }

    if (!seg || !seg.text || !seg.text.trim()) {
      if (skippedBeforeLlm) {
        queue.log('scheduler', `[segment] ${skippedBeforeLlm} → unavailable → skipped before LLM — ${silentReason}`);
      } else {
        queue.log('scheduler', `Segment director stayed silent — ${silentReason || 'nothing to add'}`);
      }
      return;
    }

    const cap = caps.find(c => c.kind === seg.kind);
    if (!cap) {
      queue.log('error', `Segment director returned unoffered kind "${seg.kind}" — dropping`);
      return;
    }

    let selectedSfx: string | null = null;
    if (seg.sfx) {
      if (sfxCatalog.some(s => s.name === seg.sfx)) selectedSfx = seg.sfx;
      else queue.log('error', `Segment director picked unknown sfx "${seg.sfx}" — dropping`);
    }

    // The speaker's id rides in meta so session.windowMessages names a guest's
    // turn as theirs rather than the host's own words.
    const delivery = await queue.announce(seg.text.trim(), seg.kind, {
      persona: speaker,
      meta: { personaId: speaker?.id, personaName: speaker?.name },
      pauseTalkEligible: true,
      sfx: selectedSfx,
    });
    if (!delivery.accepted) return;

    // Reserve the kind as soon as it owns an air path so a held segment is not
    // generated twice. Durable "aired" facts wait for the voice lifecycle.
    lastFired.set(seg.kind, Date.now());
    segmentState.lastAnySegment = Date.now();
    if (seg.kind === 'weather' && ctx.weather?.condition) {
      segmentState.lastWeatherCondition = ctx.weather.condition;
    }

    // Record what aired so the durable ledger keeps both the tool and the
    // fallback path from repeating it after a restart (#577).
    if (seg.kind === 'curiosity') {
      void delivery.completed.then(aired => {
        if (aired) recordCuriosity(seg.text.trim(), { aired: true });
      });
    }
  } catch (err) {
    // A model that couldn't produce parseable JSON was most likely trying to
    // stay silent and expressing it wrong, and the listener-facing outcome is
    // the same, so report it as silence with a parse note. Real failures
    // (network, model not loaded, retries exhausted) still log as errors.
    if (isBareNullSilent(err)) {
      queue.log('scheduler', `Segment director stayed silent — model emitted bare null (treating as intended silence)`);
    } else if (isSilentFailure(err)) {
      queue.log('scheduler', `Segment director stayed silent — output not parseable (${err.message.slice(0, 80)})`);
    } else {
      queue.log('error', `Segment director failed: ${err.message}`);
    }
  } finally {
    tickBusy = false;
  }
}

// "No parseable object" errors, which usually mean the model wanted to stay
// silent but botched the JSON. Used by segmentTick only: the operator override
// demands real output, so a parse failure there IS a failure.
function isSilentFailure(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return msg.includes('no object generated')
      || msg.includes('no output generated')
      || msg.includes('did not match schema');
}

// The "model emitted bare `null`" pattern: silence encoded at the wrong nesting
// level. Treated as intentional silence — same outcome, cleaner logs.
function isBareNullSilent(err) {
  const text = String(err?.text || '').trim();
  if (text !== 'null') return false;
  const cause = String(err?.cause?.message || '').toLowerCase();
  return cause.includes('expected object') && cause.includes('received null');
}

// Operator-override variant of directorSystem: exactly one capability, and the
// segment is mandatory unless mayAbstain. Same ultra-minimal treatment.
export function forcedSystem(persona, cap, sfxCatalog, { mayAbstain = false }: { mayAbstain?: boolean } = {}) {
  // The mandatory phrasing is right for a segment written from the moment
  // itself. A grounded skill gets the opposite instruction: "you must produce a
  // line" turned an empty search into a recycled hallucination (#1412), and the
  // recycling must be named explicitly, since the model's own recent output is
  // in its window and "don't invent" alone leaves reaching back looking like
  // compliance.
  const mandate = mayAbstain
    ? 'write it from the source data you were given, and nothing else. If that data is empty, or turns out to be about something other than what this segment covers, set "air" to false and say nothing — standing down is the right answer, and a fabricated line is far worse than no segment. Never fill the gap from memory, from what you said earlier in the show, or from what sounds plausible.'
    : 'you must produce a line, silence is not an option.';
  return `${settings.agentPersonaPreamble(persona)}

The operator asked you to air ONE ${cap.kind} segment now — ${mandate} You are NOT choosing music.

${cap.desc}${sfxBlock(sfxCatalog)}${settings.agentLanguageReminder(persona, 'the "text" line')}`;
}

// The outcome of a forced run. A held segment is `queued: true`, `aired: false`
// until its boundary; a grounded stand-down is false for both. This lets an
// operator distinguish "waiting for its break" from "nothing will play".
export interface CapabilityRun {
  aired: boolean;
  queued: boolean;
  deferred: boolean;
  text: string | null;
  reason: string | null;
}

// Operator override: fire one capability on demand, bypassing cooldowns, the
// frequency floor, persona ownership and the enable toggle. Backs POST /dj/skill,
// the per-skill cron and the programme feature beat, which passes `brief` (the
// episode plan's feature topic, appended so the segment is built around it) and
// `persona` (the rotated speaker — voice, prompt seat and session attribution
// move together).
//
// Throws on an unknown/unready capability, or on empty output from a skill with
// no grounds to stand down. Returns `{ aired: false, reason }` when a grounded
// skill's data came back unusable (#1412, skills/abstain-policy.ts).
export async function runCapability(
  which,
  ctx,
  { brief = null, persona = null, pauseTalkEligible = true }:
    { brief?: string | null; persona?: { id?: string; name?: string; skills?: string[]; tts?: unknown } | null; pauseTalkEligible?: boolean } = {},
): Promise<CapabilityRun> {
  const cap = allCapabilities().find(c => c.kind === which || c.skill === which);
  if (!cap) throw new Error(`unknown skill: ${which}`);
  if (cap.ready && !cap.ready()) {
    // Hint at the missing key when the capability is keyed.
    let hint = '';
    const searchProvider = settings.get().search?.provider;
    if (cap.kind === 'web-search' && (searchProvider === 'tavily' || searchProvider === 'brave')) {
      const name = searchProvider === 'brave' ? 'Brave Search' : 'Tavily';
      hint = ` — set SEARCH_API_KEY or paste a ${name} key into the admin UI`;
    } else if (cap.requiresKey) {
      hint = ` — set ${cap.requiresKey}`;
    }
    throw new Error(`skill "${cap.skill}" is not ready${hint}`);
  }

  if (cap.cohosts) {
    const { host, guests } = settings.getOnAirRoster();
    // A solo hour is a normal, transient state, not a misconfiguration, so it
    // reports `{aired: false, reason}` and Run now answers 200. Contrast
    // cap.ready() above, which throws because a missing key needs fixing.
    if (!host || !guests.length) {
      const reason = 'requires a co-hosted show';
      queue.log('scheduler', `[skills] "${cap.kind}" stood down — ${reason}`);
      return { aired: false, queued: false, deferred: false, text: null, reason };
    }
    const situation = buildCohostedSituation(ctx, cap, { forced: true, brief });
    const result = await runCohostedCapability({
      capability: cap, host, guests, context: ctx, situation, segmentState, forced: true,
    });
    if (!result.aired || !result.lines) {
      const reason = result.reason || 'nothing usable to discuss';
      queue.log('scheduler', `[skills] "${cap.kind}" stood down — ${reason}`);
      return { aired: false, queued: false, deferred: false, text: null, reason };
    }
    const aired = await queue.announceExchange(result.lines, cap.kind);
    if (!aired) throw new Error(`skill "${cap.skill}" co-hosted exchange failed to render`);
    lastFired.set(cap.kind, Date.now());
    segmentState.lastAnySegment = Date.now();
    if (cap.kind === 'weather' && ctx.weather?.condition) segmentState.lastWeatherCondition = ctx.weather.condition;
    if (cap.kind === 'curiosity') recordCuriosity(result.lines.map((line) => line.text).join(' '), { aired: true });
    const text = result.lines.map((line) => `${line.persona.name || 'DJ'}: ${line.text}`).join('\n');
    return { aired: true, queued: true, deferred: false, text, reason: result.reason };
  }

  const speaker = persona || settings.getEffectivePersona(new Date());
  // Empty catalogue when SFX are disabled — no segment is offered effects.
  const sfxCatalog = settings.get().sfx?.enabled === false ? [] : await sfx.catalog();
  const recentCuriosity = cap.kind === 'curiosity' ? recentAiredCuriosity() : undefined;
  const situation = buildSituation(ctx, { forced: true, contextFields: effectiveContextFields(cap), recentCuriosity })
    + (brief ? `\n\n${brief}` : '');

  // Whether this skill may stand down at all: decided before its data provider
  // is called, then applied to the fetched result.
  const mayAbstain = requiresGrounding(cap);
  // Logged here rather than at each caller, so the booth log carries one
  // wording whichever forced caller fired the skill.
  const standDown = (reason: string): CapabilityRun => {
    queue.log('scheduler', `[skills] "${cap.kind}" stood down — ${reason}`);
    return { aired: false, queued: false, deferred: false, text: null, reason };
  };

  // Fetch in code, then make one structured generation call. A skill that
  // writes from the moment survives a failed fetch (it writes from the brief
  // and moment alone); a grounded skill does not, since its whole segment was
  // to be about what the fetch did not return.
  const data = await fetchSegmentData(cap, ctx, segmentState);
  const blocked = standDownReason(cap, data);
  if (blocked) return standDown(blocked);
  const object: { reason?: string; air?: boolean; text?: string; sfx?: string | null } | undefined =
    await deadlinedSegmentObject({
      system: forcedSystem(speaker, cap, sfxCatalog, { mayAbstain }),
      prompt: situation + (data && !data.error ? dataBlock(data) : ''),
      schema: forcedSchema({ mayAbstain }),
      temperature: 0.9,
      kind: 'generateSegment',
    });

  // An explicit decline, reachable only when the schema offered `air` at all.
  if (mayAbstain && object?.air === false) {
    return standDown(object?.reason?.trim() || 'nothing usable to write the segment from');
  }

  const text = object?.text?.trim();
  if (!text) {
    // A grounded skill returning nothing has effectively declined: same silence,
    // and a red booth-log error would be wrong. Anything else is a real failure.
    if (mayAbstain) return standDown('the DJ wrote no line for this segment');
    throw new Error(`skill "${cap.skill}" produced no text`);
  }

  let selectedSfx: string | null = null;
  const pick = object?.sfx;
  if (pick) {
    if (sfxCatalog.some(s => s.name === pick)) selectedSfx = pick;
    else queue.log('error', `Segment director picked unknown sfx "${pick}" — dropping`);
  }

  // A rotated speaker rides through announce so voice and session attribution
  // agree (windowMessages names foreign speakers by meta id).
  const delivery = await queue.announce(text, cap.kind, persona
    ? {
        persona: speaker,
        meta: { personaId: speaker?.id, personaName: speaker?.name },
        pauseTalkEligible,
        sfx: selectedSfx,
      }
    : { pauseTalkEligible, sfx: selectedSfx });
  if (!delivery.accepted) {
    const reason = 'the station could not queue the rendered segment';
    queue.log('scheduler', `[skills] "${cap.kind}" stood down — ${reason}`);
    return { aired: false, queued: false, deferred: false, text: null, reason };
  }

  // Reserve the capability once it has an air path; the durable ledger below
  // waits for actual post-air completion.
  lastFired.set(cap.kind, Date.now());
  segmentState.lastAnySegment = Date.now();
  if (cap.kind === 'weather' && ctx.weather?.condition) {
    segmentState.lastWeatherCondition = ctx.weather.condition;
  }

  // Record an operator-fired curiosity line in the ledger too (#577).
  if (cap.kind === 'curiosity') {
    void delivery.completed.then(aired => {
      if (aired) recordCuriosity(text, { aired: true });
    });
  }
  return {
    aired: !delivery.deferred,
    queued: true,
    deferred: delivery.deferred,
    text,
    reason: object?.reason?.trim() || null,
  };
}

// Skill metadata for the admin command-center UI.
export function skillCatalog() {
  const s = settings.get();
  const enabledMap = s.skills?.enabled || {};
  const searchProvider = s.search?.provider || 'duckduckgo';
  return allCapabilities().map(c => {
    // web-search's key requirement depends on the active provider:
    // Tavily/Brave need SEARCH_API_KEY, DuckDuckGo needs nothing.
    let requiresKey = c.requiresKey || null;
    let keyUrl = c.keyUrl || null;
    let hint: string | null = null;
    if (c.kind === 'web-search') {
      if (searchProvider === 'tavily') {
        requiresKey = 'SEARCH_API_KEY';
        keyUrl = 'https://app.tavily.com/home';
      } else if (searchProvider === 'brave') {
        requiresKey = 'SEARCH_API_KEY';
        keyUrl = 'https://api-dashboard.search.brave.com/app/keys';
      } else if (searchProvider === 'searxng') {
        requiresKey = null;
        keyUrl = null;
        hint = 'SearXNG self-hosted meta-search. Configure base URL in admin → Settings → Search.';
      } else {
        requiresKey = null;
        keyUrl = null;
      }
    }
    return {
      name: c.skill,
      label: c.label || c.skill,
      description: c.desc || '',
      kind: c.kind,
      cooldownMs: c.cooldownMs || 0,
      // Seeded built-ins default on; operator skills stay off until flipped on.
      enabled: c.seeded ? enabledMap[c.skill] !== false : enabledMap[c.skill] === true,
      // `custom` is the API's name for "not seeded", so the admin UI can badge
      // an operator-authored skill and explain the off-by-default behaviour.
      custom: !c.seeded,
      // `ready` is false when a required env key isn't set; `requiresKey` names
      // it and `keyUrl` links to its source.
      ready: typeof c.ready === 'function' ? !!c.ready() : true,
      requiresKey,
      keyUrl,
      hint,
      warning: c.legacyInputs?.length
        ? `Legacy tool.mjs inputs (${c.legacyInputs.join(', ')}) now use the provider's default input. Review this Skill before relying on it on air.`
        : null,
      // The "right now" fields this situation may include (#471), resolved to
      // the default profile when unset so the admin UI needn't guess.
      contextFields: effectiveContextFields(c),
      // Freeform tags from SKILL.md frontmatter, for the admin list filter.
      tags: c.tags || [],
      cohosts: !!c.cohosts,
    };
  });
}
