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
// Personality dials, 0–10, default 5. They map to three prompt bands server-side
// (settings.personaToneDirectives): 0–3 low, 7–10 high, 4–6 neutral (nothing
// injected). Surfacing the band keeps operators from expecting 6 vs 7 to differ.
// `words` is the one-word band readout shown next to the knob value, indexed by
// toneBandIndex (low / neutral / high). The longer `low`/`high` strings caption
// the knob's travel ends.
export const TONE_DIALS = [
  { id: 'humour',      label: 'Humour',       low: 'play it straight', high: 'playful & dry',  words: ['straight',  'neutral', 'playful'] },
  { id: 'localColour', label: 'Local colour', low: 'universal',        high: 'leans local',    words: ['universal', 'neutral', 'local']   },
  { id: 'warmth',      label: 'Warmth',       low: 'cool & dry',       high: 'warm & earnest', words: ['cool',      'neutral', 'warm']    },
] as const;
export const DIAL_NEUTRAL = 5;
// Literal 0|1|2 return keeps tuple indexing into `words` precise under
// noUncheckedIndexedAccess (no `string | undefined`).
export const toneBandIndex = (v: number): 0 | 1 | 2 => (v <= 3 ? 0 : v >= 7 ? 2 : 1);

// The knob is detented to 11 integer positions, so the rotation is a fixed
// lookup rather than an inline transform (inline styles are forbidden in admin
// sources — issue #50). Keeping each class a literal lets Tailwind's JIT emit
// them. 0 → −135°, 10 → +135°: a 270° sweep.
export const KNOB_ROTATIONS = [
  '-rotate-[135deg]', '-rotate-[108deg]', '-rotate-[81deg]', '-rotate-[54deg]', '-rotate-[27deg]',
  'rotate-0',
  'rotate-[27deg]', 'rotate-[54deg]', 'rotate-[81deg]', 'rotate-[108deg]', 'rotate-[135deg]',
] as const;
export const VOICE_CELLS = 32;

// SteppedFader cap/tick/fill positions, keyed by stop count. Same rationale as
// KNOB_ROTATIONS: the fader is detented to named stops, so position is a fixed
// class lookup (inline styles are forbidden in admin sources — issue #50) and
// each literal lets Tailwind's JIT emit it. Stops are evenly spaced.
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

// Chatterbox reference voice files are validated against this in audio/chatterbox.ts
// — basename only, no path separators, .wav extension, conservative chars.
export const CHATTERBOX_VOICE_RE = /^[A-Za-z0-9_.-]{1,80}\.wav$/;
// Sentinel for the empty-string "use the built-in voice" choice — Radix Select
// rejects an empty-string SelectItem value.
export const CB_DEFAULT_VOICE = '__cb_default__';
// PocketTTS voice ids — lowercase, allow underscores/hyphens (matches the
// settings-side POCKET_TTS_VOICE_RE).
export const POCKET_TTS_VOICE_RE = /^[a-z][a-z0-9_-]{0,39}$/;
export const KOKORO_RE = /^[a-z]{2}_[a-z0-9]+$/;

export const NAME_MAX = 40;
export const TAGLINE_MAX = 80;
export const SOUL_MAX = 1000;
export const LANGUAGE_MAX = 60;
export const PROMPT_MIN = 50;
export const PROMPT_MAX = 4000;
// Prompt-template library caps — keep in lockstep with the controller's
// DJ_PROMPT_LIMIT / DJ_PROMPT_NAME_MAX (settings.ts).
export const PROMPT_PRESET_MAX = 20;
export const PROMPT_NAME_MAX = 60;
export const PERSONA_MAX = 48;

// 512×512 output target. The controller hard-caps the decoded image at 300 KB
// and the JSON body at 600 KB; a center-cropped 512×512 WebP from a typical
// phone photo lands in the tens of KB, well under both.
export const AVATAR_TARGET_PX = 512;

// DiceBear styles to roll through when the operator clicks Generate. Each
// click picks one at random along with a fresh random seed, so re-clicking
// produces a different face. Lorelei / notionists / personas / open-peeps are
// illustrated humans; bottts-neutral / micah / fun-emoji add a robot/abstract
// option so the operator can keep clicking until they land on a vibe that
// fits the persona. All return PNG at the size we ask for, with permissive
// CORS — the fetch can run in the browser.
export const DICEBEAR_STYLES = [
  'lorelei', 'notionists', 'personas', 'open-peeps',
  'micah', 'bottts-neutral', 'fun-emoji',
];

export const API_BASE = process.env.NEXT_PUBLIC_API_URL || '/api';
