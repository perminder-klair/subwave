// Pure spoken-text normalizer between generated copy and the TTS engines
// (#963). Rules stay conservative: real artist/title text rides the same lines
// ("Ke$ha", "AC/DC", "P!nk" must survive), and bracketed text is left alone so
// Chatterbox's [laugh]/[sigh] tags keep their brackets. No digit-to-word
// expansion; scope is symbols and markup only.
//
// TWO passes, and the split is load-bearing (#1186):
//   normalizeForDisplay() — markup + entity cleanup only. Safe for anything a
//     PERSON reads: booth log, session memory, the player's feed.
//   normalizeForSpeech()  — the above PLUS the pronunciation layer (operator
//     corrections, unit/symbol expansion, SUB/WAVE → "Subwave"). These are
//     spelled for an ENGINE, so they must never be persisted where a human
//     sees them.
//
// No imports — pure module, unit-pinned by scripts/speech-text.test.ts.

// Operator-defined correction (settings.tts.corrections) for terms the engines
// mispronounce. Passed in as an argument, never read from settings, so this
// module stays pure.
export interface SpeechCorrection {
  from: string;
  to: string;
}

// Case-insensitive and word-bounded, but the \b anchor goes on an edge only
// where that edge is a word character: "live" must not fire inside "delivery",
// while a rule edged with a symbol ("Ke$ha") has no boundary to anchor on.
const REGEX_SPECIALS_RE = /[.*+?^${}()|[\]\\]/g;

function correctionPattern(from: string): RegExp {
  const escaped = from.replace(REGEX_SPECIALS_RE, '\\$&');
  const lead = /^\w/.test(from) ? '\\b' : '';
  const trail = /\w$/.test(from) ? '\\b' : '';
  return new RegExp(`${lead}${escaped}${trail}`, 'gi');
}

function applyCorrections(text: string, corrections: readonly SpeechCorrection[]): string {
  let t = text;
  for (const c of corrections) {
    const from = typeof c?.from === 'string' ? c.from.trim() : '';
    if (!from) continue;
    const to = typeof c?.to === 'string' ? c.to : '';
    // Function replacement so a "$" in the spoken form is literal text, never
    // a capture-group reference.
    t = t.replace(correctionPattern(from), () => to);
  }
  return t;
}

// Magnitude words that ride between a $ amount and the spoken "dollars":
// "$5 million" must become "5 million dollars", not "5 dollars million".
// The \b keeps "millionaire" from prefix-matching ("5 million dollarsaire").
const DOLLAR_MAGNITUDE = '(?:\\s+(?:thousand|million|billion|trillion)\\b)?';
// The $ amount itself: digits with their own formatting ("1,200", "12.50").
const DOLLAR_AMOUNT = '\\d[\\d,]*(?:\\.\\d+)?';

// Markup + entity cleanup: everything safe for a READER as well as an engine.
// Shared by both public passes so they can only disagree about spelling.
function stripMarkup(text: string): string {
  let t = text;

  // Markdown, before the unit rules so `**76°F**` works. Bold before italic so
  // `**x**` leaves no stray asterisks for the italic pass to mis-pair.
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1');
  t = t.replace(/\*([^*\n]+)\*/g, '$1');
  t = t.replace(/__([^_]+)__/g, '$1');
  // Single-underscore emphasis only when it wraps a word run (snake_case and
  // file_names have word chars on the outside of each underscore — untouched).
  t = t.replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, '$1');
  t = t.replace(/`([^`]+)`/g, '$1');
  // Leading markdown headings on any line.
  t = t.replace(/^#{1,6}\s+/gm, '');
  // Leftover decorative marks that are never spoken. NOT brackets (Chatterbox
  // [laugh] tags) and NOT lone underscores (titles/filenames).
  t = t.replace(/[*`]/g, '');

  // HTML entities, decoded BEFORE the symbol rules so "&amp;" reads as "and",
  // not "and amp;". Only the ones that show up in chat-model output.
  t = t.replace(/&amp;/gi, '&');
  t = t.replace(/&(?:#0*39|apos|#0*8217|rsquo);/gi, "'");
  t = t.replace(/&(?:#0*34|quot|#0*8220|ldquo|#0*8221|rdquo);/gi, '"');
  t = t.replace(/&nbsp;/gi, ' ');

  return t;
}

function collapseSpace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// The READER's form: markup and entities cleaned, spelling left as written.
// Logged, persisted to the session, and pushed to the player.
export function normalizeForDisplay(text: string): string {
  if (!text) return text;
  return collapseSpace(stripMarkup(text));
}

export function normalizeForSpeech(
  text: string,
  corrections?: readonly SpeechCorrection[],
): string {
  if (!text) return text;
  let t = stripMarkup(text);

  // After markup cleanup so a rule matches the text the operator sees, and
  // BEFORE the symbol rules so a correction can pre-empt a built-in expansion.
  if (corrections?.length) t = applyCorrections(t, corrections);

  // Units and symbols, all keyed on an adjacent digit.
  t = t.replace(/(\d)\s*°\s*F\b/g, '$1 degrees Fahrenheit');
  t = t.replace(/(\d)\s*°\s*C\b/g, '$1 degrees Celsius');
  // Bare degree, after the F/C passes so only unitless degrees remain; a °
  // glued to any other letter is left alone.
  t = t.replace(/(\d)\s*°(?![A-Za-z])/g, '$1 degrees');
  t = t.replace(/(\d)\s*%/g, '$1 percent');
  // $ only when it PRECEDES a number, so "Ke$ha" survives. Four passes, most
  // specific first. 1: the model already wrote the spoken form, so drop the
  // symbol rather than speak "dollars" twice.
  t = t.replace(
    new RegExp(`\\$(${DOLLAR_AMOUNT}${DOLLAR_MAGNITUDE})(?=\\s+dollars?\\b)`, 'gi'),
    '$1',
  );
  // 2/3: compact suffixes ("$100k"), expanded so the letter can't glue onto
  // "dollars". Anchored on the $ AND the suffix, so "5k run" is untouched.
  t = t.replace(new RegExp(`\\$(${DOLLAR_AMOUNT})k\\b`, 'gi'), '$1 thousand dollars');
  t = t.replace(new RegExp(`\\$(${DOLLAR_AMOUNT})m\\b`, 'gi'), '$1 million dollars');
  t = t.replace(new RegExp(`\\$(${DOLLAR_AMOUNT})(?:bn|b)\\b`, 'gi'), '$1 billion dollars');
  // 4: the plain form. The trailing (?!\w) leaves any other glued suffix
  // ("$100x") alone entirely; unspoken beats mangled.
  t = t.replace(
    new RegExp(`\\$(${DOLLAR_AMOUNT}${DOLLAR_MAGNITUDE})(?!\\w)`, 'gi'),
    '$1 dollars',
  );
  t = t.replace(/(\d)\s*mph\b/gi, '$1 miles per hour');
  t = t.replace(/(\d)\s*km\/h\b/gi, '$1 kilometers per hour');
  // "&" reads as "and" everywhere, including inside names, EXCEPT when it opens
  // an entity-shaped sequence not decoded above ("&lt;").
  t = t.replace(/\s*&(?!(?:#\d+|[a-zA-Z]+);)\s*/g, ' and ');

  // Engines read "SUB/WAVE" as "sub slash wave".
  t = t.replace(/\bSUB\s*(?:\/|slash)\s*WAVE\b/gi, 'Subwave');

  return collapseSpace(t);
}

function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

// Convert a SPOKEN-word ceiling into the equivalent DISPLAY-word ceiling.
// enforceIntroBudget is a duration budget, so it must count what the engine
// reads, but the trim has to land on display text whose clause boundaries the
// listener reads back. Folding display÷spoken into the pace scale keeps the
// ceiling in spoken words while the cut lands on display words. 1 when either
// side is empty or the two agree; clamped so one pathological correction can't
// collapse or balloon every line's budget.
export function spokenWordScale(display: string, spoken: string): number {
  const d = wordCount(display);
  const s = wordCount(spoken);
  if (!d || !s) return 1;
  return Math.min(4, Math.max(0.25, d / s));
}
