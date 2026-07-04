// Segment-director agent — the agentic replacement for the registry's old
// filter-and-random-pick skills tick.
//
// The 5-minute cron (scheduler.skillsTick) calls agenticTick(). Instead of
// mechanically picking an eligible skill, it hands a focused snapshot of the
// moment (what's on air, what the DJ has already said recently) plus a set of
// real-world data tools (llm/segment-tools.js) to a tool-loop agent and asks
// one question: "is there anything worth saying between tracks right now —
// and if so, what?" The agent may look at the weather, the headlines, or
// artist news, then either writes ONE spoken line or stays silent.
//
// It is deliberately NOT given the full track-pick session history: that
// history is mostly "pick the next song" chatter, which small models latch
// onto and start reasoning about music instead of the segment decision. The
// anti-repeat context it needs is queue.getDjRecap() — what actually aired.
//
// Both the autonomous tick AND the operator override now run through this
// agent. `agenticTick()` is the 5-minute cron; `runCapability()` is the
// /dj/skill manual override — same tool-loop, but forced to one capability
// with cooldowns bypassed. The capability registry is loaded by skills/loader.js
// from the single load root state/skills/<slug>/ (the seven built-ins are seeded
// there on first boot from src/skills/builtins/ templates; see skills/scaffold.js).
// This module consumes it (allCapabilities) and backs the admin catalogue via
// `skillCatalog()`. The skill modules left in this directory — news.js,
// web-search.js, curiosity.js — are pure fetch helpers behind station-services.
//
// Guard rails the autonomous tick cannot talk its way past (the operator
// override bypasses all of them — when the operator asks, they get a segment):
//   - per-kind hard cooldown (from each skill's SKILL.md)
//   - a frequency-derived floor on the gap between ANY two segments
//   - capabilities the operator disabled, or the on-air persona doesn't own,
//     are never offered
//   - commute-only skills (via `window: commute`) air only during commute hours;
//     search-backed skills (web-search, now-playing-dig) only with a provider

import { z } from 'zod';
import { queue } from '../broadcast/queue.js';
import * as settings from '../settings.js';
import { defineAgent } from '../llm/agent.js';
import { buildContextLines, CONTEXT_FIELDS, lengthPhrase } from '../llm/dj.js';
import { buildSegmentTools } from '../llm/segment-tools.js';
import { recordCuriosity, recentAiredCuriosity } from './curiosity.js';
import { loadedCapabilities } from './loader.js';
import * as sfx from '../broadcast/sfx.js';

// The capability registry now lives entirely in skills/loader.js, which loads
// every skill — shipped and operator-added — from a directory (SKILL.md +
// optional tool.mjs). Each cap carries: kind/skill (the queue.announce kind +
// enable-toggle slug), label, cooldownMs, desc (the agent brief), contextFields
// (the "right now" fields it may mention; unset → default profile, no weather),
// window, requiresKey, ready() (from the tool module or the env key), seeded
// (shipped built-in vs operator skill), and the wrapped data tool
// (toolFn/toolName/toolDesc/config). Every skill lives under state/skills/<slug>/.

// The full capability set the segment director operates over: every skill loaded
// from state/skills — seeded built-ins and operator-dropped custom skills alike,
// on one footing. Everything downstream — the autonomous tick, runCapability,
// skillCatalog, the admin toggles — iterates THIS, so a dropped skill lights up
// the whole chain. Non-seeded (operator) caps are gated more conservatively
// (disabled until enabled). Read live so a rescan takes effect at once.
function allCapabilities(): any[] {
  return loadedCapabilities();
}

// The default per-skill context profile: every "right now" field EXCEPT
// weather. A capability sees weather only when it (or its SKILL.md `context:`
// override) explicitly asks for it — see issue #471.
const DEFAULT_SEGMENT_CONTEXT = (CONTEXT_FIELDS as readonly string[]).filter(f => f !== 'weather');

// The context fields a single capability's situation block should carry.
// cap.contextFields may be an array (built-ins) or a comma-string (custom
// skills / built-in overrides, straight from SKILL.md frontmatter). Absent or
// empty → the default profile (no weather).
export function effectiveContextFields(cap: any): string[] {
  const raw = cap?.contextFields;
  if (raw == null) return DEFAULT_SEGMENT_CONTEXT;
  const list = Array.isArray(raw)
    ? raw.map((s: any) => String(s).trim()).filter(Boolean)
    : String(raw).split(',').map(s => s.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_SEGMENT_CONTEXT;
}

// Union of the context fields across the capabilities on offer this tick. The
// autonomous director makes ONE decision over many capabilities, so it sees a
// field if ANY offered capability wants it: when the weather skill is
// off-cooldown weather shows up, but on the (many) ticks it isn't eligible the
// director never sees weather and can't tempt a news/curiosity line into it.
function unionContextFields(caps: any[]): string[] {
  const out = new Set<string>();
  for (const c of caps) for (const f of effectiveContextFields(c)) out.add(f);
  return [...out];
}

// Schema factories, resolved per run (defineAgent's function-schema form): the
// spoken-line length follows the on-air persona's scriptLength via
// lengthPhrase('segment'), so an 'extended' storytelling persona stretches its
// segments the way it already stretches intros and links. A hard-coded
// description here previously pinned every persona to one-liners.
function segmentSchema() {
  return z.object({
    segment: z.object({
      // Kept as a free string (not a fixed enum) so operator-dropped custom
      // skills get valid kinds too. The agent is told which kinds are on offer in
      // the system prompt, and agenticTick drops any kind it wasn't offered.
      kind: z.string()
        .describe('the segment kind — MUST be one of the kinds offered in the system prompt for this tick'),
      text: z.string().describe(`the spoken line in the DJ voice — ${lengthPhrase('segment')}`),
      sfx: z.string().nullable().describe('the exact name of one sound effect from the catalogue in the system prompt to play under this line, or null for no effect (null is usually right — most segments need none)'),
    }).nullable().describe('the segment to air, or null to stay silent — silence is a perfectly good answer, often the best one, when the data is dull, stale, unchanged, or there is nothing fresh worth a listener\'s attention'),
    reason: z.string().describe('one short internal sentence on why this segment (or why silent) — never shown to the listener'),
  });
}

// Operator-override schema: the segment is mandatory, the kind is already
// known, so the agent only returns the spoken line.
function forcedSchema() {
  return z.object({
    text: z.string().describe(`the spoken line in the DJ voice — ${lengthPhrase('segment')}`),
    sfx: z.string().nullable().describe('the exact name of one sound effect from the catalogue in the system prompt to play under this line, or null for no effect'),
  });
}

// The optional sound-effects block appended to the agent's system prompt.
// Returns '' when the library is empty — the feature stays invisible to the
// agent and nothing in the schema can be satisfied.
function sfxBlock(sfxCatalog: any) {
  if (!sfxCatalog || !sfxCatalog.length) return '';
  const list = sfxCatalog.map((s: any) => `- ${s.name}: ${s.description}`).join('\n');
  return `

SOUND EFFECTS: you may optionally play ONE sound effect underneath your voice for this segment. Use one only when it genuinely sharpens the line — most segments need none, and an effect on every break gets old fast. Set "sfx" to the exact name of an effect below, or null:
${list}`;
}

let tickBusy = false;
const lastFired = new Map<string, number>(); // kind → ms timestamp of last aired segment

// Dedup memory carried across ticks — passed straight into the segment tools.
// Curiosity dedup is NOT here anymore: it lives in the durable ledger in
// skills/curiosity.js (issue #577) so it survives a controller restart.
const segmentState: any = {
  seenHeadlines: new Set<string>(),
  lastWeatherCondition: null,
  lastSearchedArtist: null,
  lastAnySegment: 0,
};

// Minimum gap between ANY two segments, by station frequency. The cron fires
// every 5 min; aggressive stations get no extra floor.
function frequencyFloorMs(freq: string) {
  if (freq === 'quiet') return 30 * 60 * 1000;
  if (freq === 'aggressive') return 0;
  return 15 * 60 * 1000; // moderate
}

// Capabilities on offer this tick: enabled, owned by the on-air persona,
// off-cooldown, and in-window.
function availableCapabilities(ctx: any, now: Date) {
  const s = settings.get();
  const enabled = s.skills?.enabled || {};
  const persona = settings.getEffectivePersona(now);
  const out: any[] = [];
  for (const cap of allCapabilities()) {
    // Seeded built-ins are enabled unless explicitly turned off; operator skills
    // are DISCOVERED-BUT-DISABLED — they must be explicitly enabled before they
    // can air, so dropping a folder never auto-airs unreviewed content/code.
    const isEnabled = cap.seeded ? enabled[cap.skill] !== false : enabled[cap.skill] === true;
    if (!isEnabled) continue;
    if (persona?.skills && !persona.skills.includes(cap.skill)) continue;
    if (now.getTime() - (lastFired.get(cap.kind) || 0) < cap.cooldownMs) continue;
    // Window gating: custom skills opt into commute-hours-only firing via
    // `window: commute` in their SKILL.md frontmatter. (No built-in is
    // commute-gated by default since the traffic skill was retired.)
    if (cap.window === 'commute' && !ctx.clock?.isCommute) continue;
    if (cap.ready && !cap.ready()) continue;
    out.push(cap);
  }
  return out;
}

// Ultra-minimal — persona + per-tick dynamic context (capability list, station
// tone, sfx catalog). Everything else (response shape, silent-null option,
// "call done", length, tool exploration) is conveyed via the AI SDK's
// channels: the segment-tools.js tool descriptions, the schema field
// descriptions on segmentSchema above, the done-tool description in sdk.js,
// and the buildSituation() user message. Same principle as pickSystem.
function directorSystem(persona: any, caps: any[], freq: string, sfxCatalog: any) {
  const capList = caps.map((c: any) => `- ${c.kind}: ${c.desc}`).join('\n');
  const tone = freq === 'quiet'
    ? 'This is a quiet station — silence is your default.'
    : freq === 'aggressive'
      ? 'This is a lively station — frequent presence welcome, never filler.'
      : 'This is a measured station — speak only when there is something worth saying.';

  return `${settings.agentPersonaPreamble(persona)}

Your job: decide whether to air ONE between-track segment, or stay silent. You are NOT choosing music. ${tone}

Capabilities available this tick (pick one of these kinds, or stay silent):
${capList}${sfxBlock(sfxCatalog)}${settings.agentLanguageReminder(persona, 'the "text" line')}`;
}

// Wall-clock ceiling for a single segment-director run, resolved live so it
// tracks the admin-tunable setting. Same source/default as the picker's
// agentDeadline (dj-agent.ts) — segments shouldn't hang longer than picks.
function segmentDeadline(): number {
  return settings.get().llm?.agentTimeoutMs ?? 45000;
}

// The autonomous segment director — runs every 5 min, decides to air one
// segment or stay silent. Schema, prompt, and tool builder bundled here; the
// caller (agenticTick) only feeds the dynamic per-tick state.
export const directorAgent = defineAgent({
  kind: 'djAgentSegment',
  schema: () => segmentSchema(),
  // Wall-clock ceiling, mirroring the picker (dj-agent.ts). Without it a
  // gemma-class model that ignores toolChoice can drive the done-tool recovery
  // into a multi-step stall (86s observed in issue #555) and hang the tick;
  // the deadline turns that into a clean throw → handled as silence below.
  timeoutMs: segmentDeadline,
  buildSystem: ({ persona, caps, freq, sfxCatalog }) =>
    directorSystem(persona, caps, freq, sfxCatalog),
  buildTools: ({ ctx, segmentState, caps }) => ({
    tools: buildSegmentTools(ctx, segmentState, caps),
  }),
});

// The concrete situation handed to the agent as its single user turn. Built
// from what is on air and queue.getDjRecap() (what actually aired recently) —
// NOT the track-pick session history, which derails small models.
function buildSituation(ctx: any, { forced = false, contextFields, recentCuriosity }: { forced?: boolean; contextFields?: string[]; recentCuriosity?: string[] } = {}) {
  const lines = ['The current moment:'];
  const ctxLines = buildContextLines(ctx, { contextFields });
  if (ctxLines.length) lines.push(...ctxLines);
  const cur = queue.current?.track;
  if (cur) lines.push(`On air now: "${cur.title}" by ${cur.artist || 'unknown'}`);
  const recap = queue.getDjRecap();
  if (recap) {
    lines.push(`\nWhat you have already said on air recently (do NOT repeat these topics or phrasing):\n${recap}`);
  }
  // Durable curiosity history (issue #577) — when the Wikipedia pool is
  // exhausted the agent falls back to free generation, which otherwise has no
  // memory of what it already aired and repeats the same factoid (sometimes
  // reworded). Surface the recent aired curiosity lines so it steers clear.
  if (recentCuriosity && recentCuriosity.length) {
    const list = recentCuriosity.map(t => `- ${t}`).join('\n');
    lines.push(`\nCuriosity facts already aired in the last few days (if you air a curiosity segment, pick something genuinely different — do NOT repeat any of these, even reworded):\n${list}`);
  }
  lines.push(forced
    ? '\nWrite the segment the operator has asked for now.'
    : '\nDecide now: air one segment, or stay silent.');
  return lines.join('\n');
}

// Called by the scheduler's 5-minute cron. Picks at most one segment to air,
// or stays silent. Never throws — failures are logged and the tick ends.
export async function agenticTick(ctx) {
  if (tickBusy) return;

  const now = new Date();
  const persona = settings.getEffectivePersona(now);
  // DJ-mode personas read one rung chattier, lowering the floor so more
  // between-track segments (weather, curiosity, deep cuts) get through.
  const freq = settings.effectiveFrequency(persona);

  // Floor on the gap between any two spoken breaks. lastAnySegment only sees
  // what THIS agent aired, but the scheduler's station idents and hourly
  // checks share the same on-air voice (and the ident cron minutes
  // :15/:30/:45 all land on this 5-minute tick), so without queue's view the
  // DJ could talk twice in the same minute — the same stacking issue #310
  // fixed for ident+hourly at :00. Deliberately narrowed to the wall-clock
  // talkers: track-tied links/intros fire every few tracks and would mute the
  // director outright under a 15-minute moderate floor.
  const lastSpoke = Math.max(
    segmentState.lastAnySegment,
    queue.getLastVoiceAt(['station-id', 'hourly-check', 'handoff']),
  );
  if (now.getTime() - lastSpoke < frequencyFloorMs(freq)) return;

  const caps = availableCapabilities(ctx, now);
  if (caps.length === 0) return;

  // Cheap skip: if weather is the only thing on offer and it hasn't changed,
  // there is provably nothing to say — don't spend an LLM call to learn that.
  if (caps.length === 1 && caps[0].kind === 'weather'
      && ctx.weather?.condition && ctx.weather.condition === segmentState.lastWeatherCondition) {
    return;
  }

  tickBusy = true;
  try {
    // Empty catalogue when SFX are disabled — the agent is never offered effects.
    const sfxCatalog = settings.get().sfx?.enabled === false ? [] : await sfx.catalog();
    // When curiosity is on offer, brief the agent with what it already aired so
    // a pool-exhausted fallback doesn't repeat itself (issue #577).
    const recentCuriosity = caps.some(c => c.kind === 'curiosity') ? recentAiredCuriosity() : undefined;
    const { object } = await directorAgent.run({
      messages: [{ role: 'user', content: buildSituation(ctx, { contextFields: unionContextFields(caps), recentCuriosity }) }],
      persona, caps, freq, sfxCatalog,
      ctx, segmentState,
    });

    const seg = object?.segment;
    if (!seg || !seg.text || !seg.text.trim()) {
      queue.log('scheduler', `Segment agent stayed silent — ${object?.reason || 'nothing to add'}`);
      return;
    }

    // The agent must pick a kind it was actually offered (off-cooldown etc.).
    const cap = caps.find(c => c.kind === seg.kind);
    if (!cap) {
      queue.log('error', `Segment agent returned unoffered kind "${seg.kind}" — dropping`);
      return;
    }

    lastFired.set(seg.kind, Date.now());
    segmentState.lastAnySegment = Date.now();
    if (seg.kind === 'weather' && ctx.weather?.condition) {
      segmentState.lastWeatherCondition = ctx.weather.condition;
    }

    // queue.announce appends the segment turn into the live session.
    await queue.announce(seg.text.trim(), seg.kind);

    // Record what actually aired so the durable ledger can keep both the tool
    // and the fallback path from repeating it after a restart (issue #577).
    if (seg.kind === 'curiosity') recordCuriosity(seg.text.trim(), { aired: true });

    // Optional sound effect mixed under the voice. Only honour a name the
    // agent was actually offered — anything else is dropped, like an
    // unoffered kind.
    if (seg.sfx) {
      if (sfxCatalog.some(s => s.name === seg.sfx)) {
        await queue.playSfx(seg.sfx, { underVoice: true });
      } else {
        queue.log('error', `Segment agent picked unknown sfx "${seg.sfx}" — dropping`);
      }
    }
  } catch (err) {
    // Distinguish a model that couldn't produce parseable JSON from a real
    // outage. The schema explicitly allows {segment: null} as "stay silent",
    // and the system prompt actively encourages silence — so a model that
    // emits unparseable output was most likely TRYING to stay silent but
    // expressing it wrong. The listener-facing outcome is the same either way
    // (silence), so report it as silence with a parse note instead of
    // flooding /debug with errors. Real failures (network, model not loaded,
    // retries exhausted) still log as errors so operators see them.
    if (isBareNullSilent(err)) {
      queue.log('scheduler', `Segment agent stayed silent — model emitted bare null (treating as intended silence)`);
    } else if (isSilentFailure(err)) {
      queue.log('scheduler', `Segment agent stayed silent — output not parseable (${err.message.slice(0, 80)})`);
    } else {
      queue.log('error', `Segment agent failed: ${err.message}`);
    }
  } finally {
    tickBusy = false;
  }
}

// True for "the model produced no parseable object" errors thrown by the AI
// SDK — these usually mean the model wanted to stay silent but botched the
// JSON, not that the network or provider is broken. Used by agenticTick (not
// by runCapability — the operator override demands real output, so a parse
// failure there IS a failure).
//
// `did not call the done tool` (issue #555) is included for the same reason:
// gemma-class models on the forced done-tool path occasionally emit prose
// instead of the `done` call — even through the recovery — and throw. On the
// autonomous tick the schema allows {segment: null} and the prompt encourages
// silence, so a botched done call is overwhelmingly the model either staying
// silent in prose or fumbling a segment; either way the listener gets silence.
// (The operator-forced path doesn't use this classifier, so it still errors.)
function isSilentFailure(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return msg.includes('no object generated')
      || msg.includes('no output generated')
      || msg.includes('did not match schema')
      || msg.includes('did not call the done tool');
}

// Detect the specific "model emitted bare `null`" failure pattern (observed on
// minimax-m2.7:cloud and likely others). The model is trying to say "stay
// silent" but encoding it at the wrong nesting level — the schema requires
// {segment: null, reason: "..."} but the model returns top-level null.
// Treating this as intentional silence is strictly safer than failing the
// tick: same listener-facing outcome (silence) with cleaner logs.
function isBareNullSilent(err) {
  const text = String(err?.text || '').trim();
  if (text !== 'null') return false;
  const cause = String(err?.cause?.message || '').toLowerCase();
  return cause.includes('expected object') && cause.includes('received null');
}

// Operator-override variant of directorSystem: exactly one capability, and the
// segment is mandatory — the agent does not get the option to stay silent.
// Same ultra-minimal treatment as directorSystem — the forcedSchema text
// description and the segment-tools.js tool descriptions carry the rest.
function forcedSystem(persona, cap, sfxCatalog) {
  return `${settings.agentPersonaPreamble(persona)}

The operator asked you to air ONE ${cap.kind} segment now — you must produce a line, silence is not an option. You are NOT choosing music.

${cap.desc}${sfxBlock(sfxCatalog)}${settings.agentLanguageReminder(persona, 'the "text" line')}`;
}

// The operator-override variant of directorAgent — exactly one capability,
// the segment is mandatory, silence is not an option.
export const forcedDirectorAgent = defineAgent({
  kind: 'djAgentSegment',
  schema: () => forcedSchema(),
  // Same wall-clock ceiling as the autonomous director (issue #555).
  timeoutMs: segmentDeadline,
  buildSystem: ({ persona, cap, sfxCatalog }) => forcedSystem(persona, cap, sfxCatalog),
  buildTools: ({ ctx, segmentState, cap }) => ({
    tools: buildSegmentTools(ctx, segmentState, [cap]),
  }),
});

// Operator override — fire one capability on demand, bypassing cooldowns, the
// frequency floor, persona ownership and the enable toggle. Backs POST
// /dj/skill. `which` is a kind or skill slug (kept identical). Returns the
// spoken text; throws on an unknown/unready capability or empty output.
export async function runCapability(which, ctx) {
  const cap = allCapabilities().find(c => c.kind === which || c.skill === which);
  if (!cap) throw new Error(`unknown skill: ${which}`);
  if (cap.ready && !cap.ready()) {
    // Hint at the missing key when the capability is keyed. web-search is the
    // only such capability today, and only when Tavily is the active provider.
    let hint = '';
    if (cap.kind === 'web-search' && settings.get().search?.provider === 'tavily') {
      hint = ' — set SEARCH_API_KEY or paste a Tavily key into the admin UI';
    } else if (cap.requiresKey) {
      hint = ` — set ${cap.requiresKey}`;
    }
    throw new Error(`skill "${cap.skill}" is not ready${hint}`);
  }

  const persona = settings.getEffectivePersona(new Date());
  // Empty catalogue when SFX are disabled — the agent is never offered effects.
  const sfxCatalog = settings.get().sfx?.enabled === false ? [] : await sfx.catalog();
  const recentCuriosity = cap.kind === 'curiosity' ? recentAiredCuriosity() : undefined;
  const { object } = await forcedDirectorAgent.run({
    messages: [{ role: 'user', content: buildSituation(ctx, { forced: true, contextFields: effectiveContextFields(cap), recentCuriosity }) }],
    persona, cap, sfxCatalog,
    ctx, segmentState,
  });

  const text = object?.text?.trim();
  if (!text) throw new Error(`skill "${cap.skill}" produced no text`);

  // Update cooldown/dedup memory so a follow-up autonomous tick doesn't
  // immediately repeat what the operator just fired.
  lastFired.set(cap.kind, Date.now());
  segmentState.lastAnySegment = Date.now();
  if (cap.kind === 'weather' && ctx.weather?.condition) {
    segmentState.lastWeatherCondition = ctx.weather.condition;
  }

  await queue.announce(text, cap.kind);

  // Record an operator-fired curiosity line in the durable ledger too, so a
  // later autonomous tick doesn't repeat it (issue #577).
  if (cap.kind === 'curiosity') recordCuriosity(text, { aired: true });

  // Optional sound effect under the voice — only a name the agent was offered.
  const pick = object?.sfx;
  if (pick) {
    if (sfxCatalog.some(s => s.name === pick)) {
      await queue.playSfx(pick, { underVoice: true });
    } else {
      queue.log('error', `Segment agent picked unknown sfx "${pick}" — dropping`);
    }
  }
  return text;
}

// Skill metadata for the admin command-center UI — derived straight from
// CAPABILITIES. Previously lived in the now-deleted skills/_registry.js.
export function skillCatalog() {
  const s = settings.get();
  const enabledMap = s.skills?.enabled || {};
  const searchProvider = s.search?.provider || 'duckduckgo';
  return allCapabilities().map(c => {
    // web-search's key requirement depends on the active search provider:
    // Tavily needs SEARCH_API_KEY, DuckDuckGo needs nothing. Other capabilities
    // carry their requiresKey/keyUrl statically in CAPABILITIES (none today).
    let requiresKey = c.requiresKey || null;
    let keyUrl = c.keyUrl || null;
    let hint: string | null = null;
    if (c.kind === 'web-search') {
      if (searchProvider === 'tavily') {
        requiresKey = 'SEARCH_API_KEY';
        keyUrl = 'https://app.tavily.com/home';
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
      // Seeded built-ins default on; operator skills are discovered-but-disabled
      // and only count as enabled once the operator explicitly flips them on.
      enabled: c.seeded ? enabledMap[c.skill] !== false : enabledMap[c.skill] === true,
      // Marks an operator-authored skill vs a shipped built-in, so the admin UI
      // can badge it and explain the off-by-default behaviour. (`custom` is the
      // API's name for "not seeded".)
      custom: !c.seeded,
      // `ready` is false when the capability needs an env key that isn't set;
      // `requiresKey` names it and `keyUrl` links the operator to its source.
      ready: typeof c.ready === 'function' ? !!c.ready() : true,
      requiresKey,
      keyUrl,
      hint,
      // News feed surfaced so /admin/skills can show/edit the current feed
      // without a second fetch. Undefined on every other capability.
      feed: c.feed || null,
      feedMaxItems: c.feedMaxItems || null,
      // The "right now" fields this segment's situation may include (issue
      // #471). Resolved to the default profile (no weather) when unset, so the
      // admin UI can render the current tick-box selection without guessing.
      contextFields: effectiveContextFields(c),
    };
  });
}
