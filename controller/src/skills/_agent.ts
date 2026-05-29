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
// with cooldowns bypassed. The CAPABILITIES table below is the single source
// of truth, and also backs the admin catalogue via `skillCatalog()`. The only
// skill modules left in this directory — news.js, web-search.js — are pure
// fetch helpers that back the segment tools (llm/segment-tools.js).
//
// Guard rails the autonomous tick cannot talk its way past (the operator
// override bypasses all of them — when the operator asks, they get a segment):
//   - per-kind hard cooldown (CAPABILITIES below)
//   - a frequency-derived floor on the gap between ANY two segments
//   - capabilities the operator disabled, or the on-air persona doesn't own,
//     are never offered
//   - traffic is only offered during commute hours; web-search only with a key

import { z } from 'zod';
import { queue } from '../broadcast/queue.js';
import * as settings from '../settings.js';
import { defineAgent } from '../llm/agent.js';
import { buildContextLines } from '../llm/dj.js';
import { buildSegmentTools } from '../llm/segment-tools.js';
import { searchReady } from './web-search.js';
import { customCapabilities } from './loader.js';
import * as sfx from '../broadcast/sfx.js';

// Capability table — the single source of truth for the DJ's between-track
// segment capabilities. Each entry carries:
//   kind        — the queue.announce kind
//   skill       — the operator enable-toggle slug (kept identical to `kind`)
//   label       — human label for the admin command-center UI
//   cooldownMs  — hard minimum gap between autonomous firings of this kind
//   desc        — the one-line briefing shown BOTH to the agent (per-capability
//                 guidance — for traffic, which has no data tool, this is the
//                 agent's ONLY brief) and to the admin UI
//   requiresKey — (optional) env key the capability needs
//   keyUrl      — (optional) where the operator obtains that key
//   ready       — (optional) () => boolean; false when the env key is missing
// CAPABILITIES backs the agentic tick, the operator override (runCapability),
// and the admin catalogue (skillCatalog).
const CAPABILITIES: any[] = [
  {
    kind: 'weather', skill: 'weather', label: 'Weather',
    cooldownMs: 25 * 60 * 1000,
    desc: 'A short weather check, in character — one or two sentences. Only worth airing when conditions have genuinely changed.',
  },
  {
    kind: 'news', skill: 'news', label: 'News headlines',
    cooldownMs: 45 * 60 * 1000,
    desc: 'Read one fresh headline in a single sentence — half-distracted BBC 6 Music tone, never an anchor voice, no editorialising, no "in other news".',
  },
  {
    kind: 'traffic', skill: 'traffic', label: 'Traffic',
    cooldownMs: 90 * 60 * 1000,
    desc: 'A tongue-in-cheek made-up "traffic update for the listening area" — one absurd, small-scale sentence (a cat on the cable, a queue at the kettle, slow buffering on the M6). Never a real road incident.',
  },
  {
    kind: 'curiosity', skill: 'curiosity', label: 'Curiosity',
    cooldownMs: 60 * 60 * 1000,
    desc: 'One oddly-specific moment of interest — a real "on this day in 19xx" beat from history if the tool surfaces a good one, otherwise a concrete factoid lightly themed to the hour or season. Never say "fun fact", "interestingly", or "did you know".',
  },
  {
    kind: 'album-anniversary', skill: 'album-anniversary', label: 'Album anniversary',
    cooldownMs: 6 * 60 * 60 * 1000,
    desc: 'If the album currently on air is hitting a 5/10/20/25-year mark this year, note it like a presenter spotting a date in the prep notes — one short sentence, never gushing, never "classic".',
  },
  {
    kind: 'library-deep-cut', skill: 'library-deep-cut', label: 'Library deep-cut tease',
    cooldownMs: 90 * 60 * 1000,
    desc: 'If the on-air artist has a track in the library that has not been played in months, tease that it might come around later — one sentence, like a presenter teasing the rest of the show. Never name the track unless the tool surfaced exactly one.',
  },
  {
    kind: 'web-search', skill: 'web-search', label: 'Web search',
    cooldownMs: 60 * 60 * 1000,
    // requiresKey/keyUrl depend on the active search provider — see
    // skillCatalog() below, which derives them from settings.search.provider.
    // DuckDuckGo (the default) needs no key; Tavily needs SEARCH_API_KEY (or a
    // key pasted into the admin UI). searchReady() encapsulates both.
    ready: () => searchReady(),
    desc: 'Work one genuine, recent detail about the artist on air into a single conversational line — no "I read online", no URLs, no list.',
  },
];

// The full capability set the segment director operates over: the built-in
// CAPABILITIES above plus operator-dropped custom skills loaded from
// state/skills (see skills/loader.js). Everything downstream — the autonomous
// tick, runCapability, skillCatalog, the admin toggles — iterates THIS, so a
// dropped skill lights up the whole chain. Custom caps carry { custom: true }
// and are gated more conservatively (disabled until the operator enables them).
function allCapabilities(): any[] {
  return [...CAPABILITIES, ...customCapabilities()];
}

const SEGMENT_SCHEMA = z.object({
  segment: z.object({
    // Kept as a free string (not a fixed enum) so operator-dropped custom
    // skills get valid kinds too. The agent is told which kinds are on offer in
    // the system prompt, and agenticTick drops any kind it wasn't offered.
    kind: z.string()
      .describe('the segment kind — MUST be one of the kinds offered in the system prompt for this tick'),
    text: z.string().describe('the spoken line in the DJ voice — typically one short sentence, never more than three'),
    sfx: z.string().nullable().describe('the exact name of one sound effect from the catalogue in the system prompt to play under this line, or null for no effect (null is usually right — most segments need none)'),
  }).nullable().describe('the segment to air, or null to stay silent — silence is a perfectly good answer, often the best one, when the data is dull, stale, unchanged, or there is nothing fresh worth a listener\'s attention'),
  reason: z.string().describe('one short internal sentence on why this segment (or why silent) — never shown to the listener'),
});

// Operator-override schema: the segment is mandatory, the kind is already
// known, so the agent only returns the spoken line.
const FORCED_SCHEMA = z.object({
  text: z.string().describe('the spoken line in the DJ voice — typically one short sentence, never more than three'),
  sfx: z.string().nullable().describe('the exact name of one sound effect from the catalogue in the system prompt to play under this line, or null for no effect'),
});

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
const segmentState: any = {
  seenHeadlines: new Set<string>(),
  seenCuriosity: new Set<string>(),
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
    // Built-ins are enabled unless explicitly turned off; custom skills are
    // DISCOVERED-BUT-DISABLED — they must be explicitly enabled before they
    // can air, so dropping a folder never auto-airs unreviewed content/code.
    const isEnabled = cap.custom ? enabled[cap.skill] === true : enabled[cap.skill] !== false;
    if (!isEnabled) continue;
    if (persona?.skills && !persona.skills.includes(cap.skill)) continue;
    if (now.getTime() - (lastFired.get(cap.kind) || 0) < cap.cooldownMs) continue;
    // Window gating: built-in traffic is commute-only; custom skills opt in via
    // `window: commute` in their SKILL.md frontmatter.
    if ((cap.kind === 'traffic' || cap.window === 'commute') && !ctx.clock?.isCommute) continue;
    if (cap.ready && !cap.ready()) continue;
    out.push(cap);
  }
  return out;
}

// Ultra-minimal — persona + per-tick dynamic context (capability list, station
// tone, sfx catalog). Everything else (response shape, silent-null option,
// "call done", length, tool exploration) is conveyed via the AI SDK's
// channels: the segment-tools.js tool descriptions, the schema field
// descriptions on SEGMENT_SCHEMA above, the done-tool description in sdk.js,
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
${capList}${sfxBlock(sfxCatalog)}`;
}

// The autonomous segment director — runs every 5 min, decides to air one
// segment or stay silent. Schema, prompt, and tool builder bundled here; the
// caller (agenticTick) only feeds the dynamic per-tick state.
export const directorAgent = defineAgent({
  kind: 'djAgentSegment',
  schema: SEGMENT_SCHEMA,
  buildSystem: ({ persona, caps, freq, sfxCatalog }) =>
    directorSystem(persona, caps, freq, sfxCatalog),
  buildTools: ({ ctx, segmentState, caps }) => ({
    tools: buildSegmentTools(ctx, segmentState, caps),
  }),
});

// The concrete situation handed to the agent as its single user turn. Built
// from what is on air and queue.getDjRecap() (what actually aired recently) —
// NOT the track-pick session history, which derails small models.
function buildSituation(ctx: any, { forced = false }: { forced?: boolean } = {}) {
  const lines = ['The current moment:'];
  const ctxLines = buildContextLines(ctx);
  if (ctxLines.length) lines.push(...ctxLines);
  const cur = queue.current?.track;
  if (cur) lines.push(`On air now: "${cur.title}" by ${cur.artist || 'unknown'}`);
  const recap = queue.getDjRecap();
  if (recap) {
    lines.push(`\nWhat you have already said on air recently (do NOT repeat these topics or phrasing):\n${recap}`);
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
  const freq = persona?.frequency || 'moderate';

  // Floor on the gap between any two segments.
  if (now.getTime() - segmentState.lastAnySegment < frequencyFloorMs(freq)) return;

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
    const { object } = await directorAgent.run({
      messages: [{ role: 'user', content: buildSituation(ctx) }],
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

    // Optional sound effect mixed under the voice. Only honour a name the
    // agent was actually offered — anything else is dropped, like an
    // unoffered kind.
    if (seg.sfx) {
      if (sfxCatalog.some(s => s.name === seg.sfx)) {
        await queue.playSfx(seg.sfx);
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
function isSilentFailure(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return msg.includes('no object generated')
      || msg.includes('no output generated')
      || msg.includes('did not match schema');
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
// Same ultra-minimal treatment as directorSystem — the FORCED_SCHEMA's text
// description and the segment-tools.js tool descriptions carry the rest.
function forcedSystem(persona, cap, sfxCatalog) {
  return `${settings.agentPersonaPreamble(persona)}

The operator asked you to air ONE ${cap.kind} segment now — you must produce a line, silence is not an option. You are NOT choosing music.

${cap.desc}${sfxBlock(sfxCatalog)}`;
}

// The operator-override variant of directorAgent — exactly one capability,
// the segment is mandatory, silence is not an option.
export const forcedDirectorAgent = defineAgent({
  kind: 'djAgentSegment',
  schema: FORCED_SCHEMA,
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
  const { object } = await forcedDirectorAgent.run({
    messages: [{ role: 'user', content: buildSituation(ctx, { forced: true }) }],
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

  // Optional sound effect under the voice — only a name the agent was offered.
  const pick = object?.sfx;
  if (pick) {
    if (sfxCatalog.some(s => s.name === pick)) {
      await queue.playSfx(pick);
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
    if (c.kind === 'web-search') {
      if (searchProvider === 'tavily') {
        requiresKey = 'SEARCH_API_KEY';
        keyUrl = 'https://app.tavily.com/home';
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
      // Built-ins default on; custom skills are discovered-but-disabled and
      // only count as enabled once the operator explicitly flips them on.
      enabled: c.custom ? enabledMap[c.skill] === true : enabledMap[c.skill] !== false,
      // Marks an operator-dropped skill (state/skills) vs a built-in, so the
      // admin UI can badge it and explain the off-by-default behaviour.
      custom: !!c.custom,
      // `ready` is false when the capability needs an env key that isn't set;
      // `requiresKey` names it and `keyUrl` links the operator to its source.
      ready: typeof c.ready === 'function' ? !!c.ready() : true,
      requiresKey,
      keyUrl,
    };
  });
}
