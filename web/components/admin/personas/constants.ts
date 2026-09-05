// Static config + tiny pure helpers for the personas editor. No React, no DOM.

// Ordered ascending in chattiness / verbosity — rendered as the stops of a
// SteppedFader, so the array order IS the fader travel. Ids must match the
// controller's FREQUENCIES / SCRIPT_LENGTHS ladders (settings.ts).
export const FREQUENCIES = [
  { id: 'silent',     label: 'Silent',     desc: 'Never talks on its own — no links, idents, banter or segments. Manual triggers and listener requests still speak.' },
  { id: 'quiet',      label: 'Quiet',      desc: 'Talks every 8–20 tracks · station ID once an hour · segments at most every 30 min.' },
  { id: 'moderate',   label: 'Moderate',   desc: 'Talks every 1–9 tracks · station IDs at :15 and :45 · segments at most every 15 min.' },
  { id: 'chatty',     label: 'Chatty',     desc: 'Talks every 1–5 tracks · station IDs three times an hour · banter twice an hour on guest shows.' },
  { id: 'aggressive', label: 'Aggressive', desc: 'Talks every 1–3 tracks · station IDs three times an hour · no floor between segments.' },
];
export const SCRIPT_LENGTHS = [
  { id: 'one-liner',   label: 'One-liner',   desc: 'A single quick line per segment — name it and move on.' },
  { id: 'concise',     label: 'Concise',     desc: 'Standard one-to-four sentence segments. The default.' },
  { id: 'extended',    label: 'Extended',    desc: 'Longer, storytelling segments. Roughly double the length across intros, links, weather and idents.' },
  { id: 'storyteller', label: 'Storyteller', desc: 'Long-form — proper scene-setting monologues, roughly triple the default length.' },
];
// Ids must match the controller's PERSONA_LINK_STYLES (schemas/persona.ts).
export const LINK_STYLES = [
  { id: 'natural',  label: 'Natural',  desc: 'The ordinary between-track link — sets the track up, names the artist or captures its feel, varies the opener.' },
  { id: 'announce', label: 'Announce only', desc: 'Matter-of-fact: the link is exactly "This is <artist>." or "Next up, <artist>." — nothing else.' },
];
// 0–10, default 5, mapping to three prompt bands server-side
// (settings.personaToneDirectives): 0–3 low, 7–10 high, 4–6 neutral (nothing
// injected). Surfacing the band stops operators expecting 6 vs 7 to differ.
// `words` is indexed by toneBandIndex; `low`/`high` caption the travel ends.
export const TONE_DIALS = [
  { id: 'humour',      label: 'Humour',       low: 'play it straight', high: 'playful & dry',  words: ['straight',  'neutral', 'playful'] },
  { id: 'localColour', label: 'Local colour', low: 'universal',        high: 'leans local',    words: ['universal', 'neutral', 'local']   },
  { id: 'warmth',      label: 'Warmth',       low: 'cool & dry',       high: 'warm & earnest', words: ['cool',      'neutral', 'warm']    },
] as const;
export const DIAL_NEUTRAL = 5;
// Literal 0|1|2 return keeps tuple indexing into `words` precise under
// noUncheckedIndexedAccess (no `string | undefined`).
export const toneBandIndex = (v: number): 0 | 1 | 2 => (v <= 3 ? 0 : v >= 7 ? 2 : 1);

// 11 detented positions, so rotation is a fixed lookup rather than an inline
// transform (inline styles are forbidden in admin sources — issue #50). Each class
// must stay a literal for Tailwind's JIT. 0 → −135°, 10 → +135°: a 270° sweep.
export const KNOB_ROTATIONS = [
  '-rotate-[135deg]', '-rotate-[108deg]', '-rotate-[81deg]', '-rotate-[54deg]', '-rotate-[27deg]',
  'rotate-0',
  'rotate-[27deg]', 'rotate-[54deg]', 'rotate-[81deg]', 'rotate-[108deg]', 'rotate-[135deg]',
] as const;
export const VOICE_CELLS = 32;

// Keyed by stop count, evenly spaced. Same rationale as KNOB_ROTATIONS: fixed
// class lookup, literals only (issue #50).
export const FADER_STOP_LEFT: Record<number, readonly string[]> = {
  2: ['left-0', 'left-full'],
  3: ['left-0', 'left-1/2', 'left-full'],
  4: ['left-0', 'left-1/3', 'left-2/3', 'left-full'],
  5: ['left-0', 'left-1/4', 'left-1/2', 'left-3/4', 'left-full'],
};
export const FADER_FILL_WIDTH: Record<number, readonly string[]> = {
  2: ['w-0', 'w-full'],
  3: ['w-0', 'w-1/2', 'w-full'],
  4: ['w-0', 'w-1/3', 'w-2/3', 'w-full'],
  5: ['w-0', 'w-1/4', 'w-1/2', 'w-3/4', 'w-full'],
};

// Engine descriptors live in components/admin/tts/engineMeta.ts (shared with the
// Settings voice tab) — import ENGINES from there, not here.

// Every cap and voice pattern below re-exports the mirrored schema's own
// constant under the name this editor already used, so nothing here can drift
// from the controller.
import {
  DJ_PROMPT_LIMIT,
  DJ_PROMPT_NAME_MAX,
  DJ_PROMPT_TEXT_MAX,
  PERSONA_LANGUAGE_MAX,
  PERSONA_LIMIT,
  PERSONA_NAME_MAX,
  PERSONA_SOUL_MAX,
  PERSONA_TAG_MAX,
  PERSONA_TAG_RE,
  PERSONA_TAGLINE_MAX,
  TAGS_PER_PERSONA_LIMIT,
  TTS_CHATTERBOX_VOICE_RE,
  TTS_KOKORO_VOICE_RE,
  TTS_POCKET_VOICE_RE,
} from '@/lib/schemas.generated';

export const CHATTERBOX_VOICE_RE = TTS_CHATTERBOX_VOICE_RE;
// Sentinel for the empty-string "use the built-in voice" choice — Radix Select
// rejects an empty-string SelectItem value. Purely a UI concern, so it stays.
export const CB_DEFAULT_VOICE = '__cb_default__';
export const POCKET_TTS_VOICE_RE = TTS_POCKET_VOICE_RE;
export const KOKORO_RE = TTS_KOKORO_VOICE_RE;

export const NAME_MAX = PERSONA_NAME_MAX;
export const TAGLINE_MAX = PERSONA_TAGLINE_MAX;
export const SOUL_MAX = PERSONA_SOUL_MAX;
export const LANGUAGE_MAX = PERSONA_LANGUAGE_MAX;
export const TAGS_MAX = TAGS_PER_PERSONA_LIMIT;
export const TAG_MAX = PERSONA_TAG_MAX;
export const TAG_RE = PERSONA_TAG_RE;
export const PROMPT_MAX = DJ_PROMPT_TEXT_MAX;
export const PROMPT_PRESET_MAX = DJ_PROMPT_LIMIT;
export const PROMPT_NAME_MAX = DJ_PROMPT_NAME_MAX;
// Station house rules cap — lockstep with DJ_HOUSE_RULES_MAX (settings/vocab.ts).
// Not yet on the mirror: djHouseRules converted as a scalar settings key, whose
// schema owns the bound but does not export it as a named constant.
export const HOUSE_RULES_MAX = 2000;
export const PERSONA_MAX = PERSONA_LIMIT;

// 512×512 output target. The controller hard-caps the decoded image at 300 KB
// and the JSON body at 600 KB; a center-cropped 512×512 WebP from a typical
// phone photo lands in the tens of KB, well under both.
export const AVATAR_TARGET_PX = 512;

// A mix of illustrated humans and robot/abstract styles. All return PNG at the
// requested size with permissive CORS, so the fetch can run in the browser.
export const DICEBEAR_STYLES = [
  'lorelei', 'notionists', 'personas', 'open-peeps',
  'micah', 'bottts-neutral', 'fun-emoji',
];

export const API_BASE = process.env.NEXT_PUBLIC_API_URL || '/api';
