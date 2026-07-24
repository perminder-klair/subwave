// Create-form auto-fill — turns a free-text description ("a late-night jazz host
// with a dry wit", "a Sunday-morning gospel show", "a warm sepia newspaper
// theme") into a draft persona / show / theme the admin UI pre-fills for review.
// Same structured-output path as matchRequest (djObject → Zod), so it rides the
// operator's configured station LLM with no extra keys. The schemas are
// constrained to the SAME enums the settings/theme validators enforce, so a
// generated draft round-trips through Save without surprises.

import { z } from 'zod';
import { FREQUENCIES, SCRIPT_LENGTHS, moodVocab, SHOW_ENERGY, SOUL_MAX } from '../../../settings.js';
import { THEME_TOKEN_KEYS } from '../../../themes.js';
import { djObject } from '../strategy/object.js';
import { buildContextLines } from './context.js';

// ---------------------------------------------------------------------------
// Persona
// ---------------------------------------------------------------------------

// Every field is `.catch(...)`-wrapped on purpose. These generators are a
// best-effort "draft the form, then you edit before saving" aid — a weaker model
// that omits or botches a field should yield a partial draft, NOT a hard ZodError
// the operator sees as a wall of validation issues (#492 follow-up). The model is
// still told to fill everything via .describe(); .catch only supplies a sane
// fallback when it doesn't, leaving the operator to fix it in the form. .catch
// also subsumes the "field missing entirely" (undefined) case.
const PERSONA_SCHEMA = z.object({
  name: z.string().min(1).max(40).describe('the DJ name shown in the player — 1-3 words, evocative, never generic like "DJ" or "Host"').catch('New DJ'),
  tagline: z.string().max(80).describe('a short one-line descriptor shown next to the name (e.g. "atmospheric & immersive"), 0-80 chars; "" if none fits').catch(''),
  soul: z.string().min(1).max(SOUL_MAX).describe(`the personality/voice sketch the DJ speaks with — tone, sensibility, quirks, the kind of imagery they reach for. Aim for 1-3 sentences; max ${SOUL_MAX} chars. Concrete and specific, not a list of adjectives.`).catch(''),
  frequency: z.enum(FREQUENCIES as [string, ...string[]]).describe('how chatty, ascending: silent (never talks unprompted), quiet (rarely), moderate, chatty, aggressive (talks a lot)').catch('moderate'),
  scriptLength: z.enum(SCRIPT_LENGTHS as [string, ...string[]]).describe('how long each spoken bit runs, ascending: one-liner (a single line), concise (one or two lines), extended (longer riffs), storyteller (long-form)').catch('concise'),
  djMode: z.boolean().describe('true if this host works the desk like a real radio DJ — back-announces tracks, teases what is coming, more present; false for a quieter selector').catch(true),
  language: z.string().max(60).describe('the language the DJ speaks on air if the description implies a non-English host (e.g. "Turkish", "Punjabi"); "" for English').catch(''),
});

const PERSONA_SYSTEM = `You design on-air radio DJ personalities for a personal internet radio station. Given a free-text description, produce a single coherent DJ persona: a memorable name, a short tagline, and a vivid "soul" (the voice and sensibility they present with). Match the requested vibe, era, and language. Keep the soul specific and human — no corporate filler, no "your number one source for hits". If the description names or implies a non-English host, set language to that language (in English, e.g. "Turkish"); otherwise leave it "".`;

export async function generatePersona(description: string) {
  return djObject({
    system: PERSONA_SYSTEM,
    prompt: `Description of the DJ the operator wants:\n"${description}"\n\nDesign the persona.`,
    schema: PERSONA_SCHEMA,
    temperature: 0.8,
    kind: 'generatePersona',
  });
}

// ---------------------------------------------------------------------------
// Show
// ---------------------------------------------------------------------------

interface ShowCtx {
  personas?: { id: string; name: string }[];
  themes?: { id: string; name: string }[];
  genres?: string[];
}

// `.catch(...)`-wrapped for the same reason as PERSONA_SCHEMA above: a partial
// model response (the common failure on small / non-tool-tuned local models) must
// degrade to an editable draft, not a thrown ZodError. The route then re-checks
// personaId / themeId / mood / energy / filtersStrict against the live lists
// (routes/generate.ts) — that normalisation only runs because parse no longer
// throws here.
// The mood field is added per-call in generateShow() from the LIVE vocabulary
// (settings.moods is operator-editable), so a module-load z.enum can't bake it.
const SHOW_SCHEMA_BASE = z.object({
  name: z.string().min(1).max(60).describe('the show name shown in the schedule — punchy, 1-4 words').catch('New show'),
  topic: z.string().max(1000).describe('the brief the AI DJ reads before the slot: genres, eras, moods, artists, time of day, listener type, host tone. 1-4 sentences, max 1000 chars.').catch(''),
  genre: z.string().max(64).describe('a music genre lean if one fits (e.g. "jazz", "gospel", "lofi"); "" for no lean. Prefer a genre present in the supplied library list when relevant.').catch(''),
  filtersStrict: z.boolean().describe('true ONLY when the description demands exclusivity ("only plays hip-hop", "strictly 80s", "nothing but calm tracks") — hard-locks every pick to ALL the filters set (mood, genre, era, energy). false for normal soft leans. Requires at least one filter; leave false when none is set.').catch(false),
  fromYear: z.number().int().nullable().describe('start year of an era window if the show targets a decade (e.g. 1970), else null').catch(null),
  toYear: z.number().int().nullable().describe('end year of that era window (e.g. 1979), else null').catch(null),
  energy: z.enum(['', ...SHOW_ENERGY] as [string, ...string[]]).describe('soft energy steer: low, medium, high, or "" for any').catch(''),
  personaId: z.string().nullable().describe('the id of the persona that best fits this show, chosen from the supplied persona list, or null if unsure').catch(null),
  themeId: z.string().nullable().describe('the id of a per-show theme override chosen from the supplied theme list, or null for the station default').catch(null),
});

const SHOW_SYSTEM = `You design radio shows for a personal internet radio station. Given a free-text description, produce a single show definition: a name, a DJ brief (topic), a music mood, an optional genre lean and era window, an energy steer, and the best-matching persona and (optional) theme from the supplied lists. Pick personaId / themeId ONLY from the ids given; use null when nothing clearly fits. The mood MUST be one of the listed moods. Set filtersStrict=true only when the description signals exclusivity ("only", "strictly", "nothing but", "pure <genre>") — it hard-locks every pick to ALL the set filters (mood, genre, era, energy); otherwise keep them soft leans (filtersStrict=false). Keep the topic concrete and useful as a brief — name the kind of music, the moment of day, and the tone.`;

export async function generateShow(description: string, ctx: ShowCtx = {}) {
  const moods = moodVocab();
  const showSchema = SHOW_SCHEMA_BASE.extend({
    mood: z.enum(moods as [string, ...string[]]).describe('the single closest music mood for this show').catch(moods[0]),
  });
  const lines: string[] = [];
  if (ctx.personas?.length) {
    lines.push('Available personas (id — name):');
    for (const p of ctx.personas) lines.push(`  ${p.id} — ${p.name}`);
  }
  if (ctx.themes?.length) {
    lines.push('Available themes (id — name):');
    for (const t of ctx.themes) lines.push(`  ${t.id} — ${t.name}`);
  }
  if (ctx.genres?.length) {
    lines.push(`Genres present in the library (sample): ${ctx.genres.slice(0, 40).join(', ')}`);
  }
  lines.push(`Allowed moods: ${moods.join(', ')}`);

  return djObject({
    system: SHOW_SYSTEM,
    prompt: `Description of the show the operator wants:\n"${description}"\n\n${lines.join('\n')}\n\nDesign the show.`,
    schema: showSchema,
    temperature: 0.7,
    kind: 'generateShow',
  });
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

// CSS color value the theme validator (themes.ts TOKEN_VAL_RE) will accept:
// hex, rgb()/rgba(), or a plain named color. No semicolons/braces/angle
// brackets, ≤100 chars. We keep the model on hex/rgb to stay safely inside it.
const COLOR = z.string().regex(/^[^;{}<>]{1,100}$/);

const THEME_SCHEMA = z.object({
  name: z.string().min(1).max(60).describe('a short human theme name (e.g. "Sepia Press")'),
  description: z.string().max(200).describe('a one-line blurb describing the look, "" if none'),
  tokens: z.object({
    '--bg': COLOR.describe('page background'),
    '--ink': COLOR.describe('primary text — MUST contrast strongly with --bg for readability'),
    '--muted': COLOR.describe('secondary/muted text — lower contrast than --ink but still legible on --bg'),
    '--accent': COLOR.describe('accent / interactive highlight color'),
    '--overlay': COLOR.describe('subtle wash used for hover/overlay — an rgba() with low alpha works well'),
    '--soft-border': COLOR.describe('hairline border color, close to --bg'),
    '--field': COLOR.describe('input/field surface, slightly off from --bg'),
  }).describe('the 7 CSS custom-property color values for the theme'),
});

const THEME_SYSTEM = `You are a UI color designer. Given a free-text vibe and a light/dark mode, produce a coherent, accessible color theme as 7 CSS custom properties. Use hex (#rrggbb) or rgb()/rgba() values only — never named colors, gradients, or anything with semicolons or braces. Ensure --ink reads clearly against --bg (strong contrast); --muted is a softer but still legible version; --accent stands out; --overlay is a low-alpha rgba wash; --soft-border and --field sit close to --bg. Respect the requested mode: a dark theme has a dark --bg and light text, a light theme the reverse.`;

export async function generateTheme(description: string, mode: 'light' | 'dark') {
  return djObject({
    system: THEME_SYSTEM,
    prompt: `Requested look: "${description}"\nMode: ${mode}\n\nThe token keys to fill are exactly: ${THEME_TOKEN_KEYS.join(', ')}.\n\nDesign the theme.`,
    schema: THEME_SCHEMA,
    temperature: 0.7,
    kind: 'generateTheme',
  });
}

// ---------------------------------------------------------------------------
// Manual-voice suggestions
// ---------------------------------------------------------------------------

// The canonical canned prompts for the dash's "Manual voice DJ" chip row —
// few-shot style anchors for the generator below AND the permanent fallback.
// The web client keeps its own copy (DashPanel SAY_SUGGESTIONS) for the
// zero-latency initial render; keep the two lists in step.
export const SAY_SUGGESTION_EXAMPLES = [
  'Tease the weather like it’s a rumour you can’t quite confirm.',
  'Do a station ID like you suspect nobody’s listening — and you’re fine with it.',
  'Salute the graveyard shift: night drivers, dish pits, the deliberately awake.',
  'Tease the next track without giving up the title.',
  'Remind everyone the request line exists and judges no one.',
  'Announce the time like it’s classified information.',
];

// Six NAMED slots, not an array — same "singular is kinder to weak local
// models" reasoning as SHOW_SCHEMA above: given an array field, a 4B model
// reliably emitted one item and stopped; six required fields make it fill six.
// No length bounds and .catch('') per slot: a botched or missing slot degrades
// to '' for the route's normaliser to drop, never a ZodError. The route trims,
// dedupes, and length-caps; fewer than 3 survivors = failure.
const SAY_SUGGESTIONS_SCHEMA = z.object({
  s1: z.string().describe('prompt suggestion 1 of 6').catch(''),
  s2: z.string().describe('prompt suggestion 2 of 6').catch(''),
  s3: z.string().describe('prompt suggestion 3 of 6').catch(''),
  s4: z.string().describe('prompt suggestion 4 of 6').catch(''),
  s5: z.string().describe('prompt suggestion 5 of 6').catch(''),
  s6: z.string().describe('prompt suggestion 6 of 6').catch(''),
});

const SAY_SUGGESTIONS_SYSTEM = `You write prompt suggestions for the operator of a personal internet radio station. Each suggestion is a one-line DIRECTION handed to the on-air AI DJ, who rewrites it in their own persona before speaking — so write instructions ("Tease…", "Salute…", "Announce…"), never finished on-air copy. Keep each under 90 characters: imperative, playful, a little sideways. No emoji, no numbering, no quotation marks. Never tell the DJ to say a specific track or artist name.`;

// Returns the raw slot values as a list — the route normalises (trim, dedupe,
// drop empties/over-long) and decides whether enough survived.
export async function generateSaySuggestions(context: any, nowPlaying?: any): Promise<string[]> {
  const lines = buildContextLines(context);
  if (nowPlaying?.title) {
    lines.push(`Now playing: "${nowPlaying.title}" by ${nowPlaying.artist || 'unknown'}`);
  }
  const prompt = [
    'Station status right now:',
    ...lines.map(l => `  ${l}`),
    '',
    'Suggestions in the house voice, for flavour (do NOT repeat any of these):',
    ...SAY_SUGGESTION_EXAMPLES.map(s => `  - ${s}`),
    '',
    'Write 6 fresh suggestions in that voice, one per field s1–s6. Make at least half of them react to the station status above (the hour, the weather, the day, the show on air); the rest can be evergreen bits of radio business.',
  ].join('\n');

  const out = await djObject({
    system: SAY_SUGGESTIONS_SYSTEM,
    prompt,
    schema: SAY_SUGGESTIONS_SCHEMA,
    temperature: 0.9,
    kind: 'generateSaySuggestions',
  });
  return [out.s1, out.s2, out.s3, out.s4, out.s5, out.s6];
}
