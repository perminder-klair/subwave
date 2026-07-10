// Pure spoken-text normalizer — the defensive layer between generated radio
// copy and the TTS engines (issue #963). The DJ prompts already ask for
// "spoken words only", but a model can still emit display text — weather
// units, markdown emphasis, currency symbols — and engines read it literally
// ("seventy-six F", or an awkward beat where the asterisks were). Every
// booth-bound string converges on normalizeForSpeech() in audio/tts.ts, so
// the rules here must stay conservative: real artist/title text rides the
// same lines ("Ke$ha", "AC/DC", "P!nk" must survive untouched), and
// Chatterbox's paralinguistic [laugh]/[sigh] tags must keep their brackets —
// bracketed text is deliberately left alone.
//
// Digit-to-word expansion is NOT done here: every engine already reads plain
// numbers naturally. The scope is symbols and markup only.
//
// No imports — pure module, unit-pinned by scripts/speech-text.test.ts.

// Operator-defined speech correction: replace `from` with `to` wherever it
// appears in booth-bound text (settings.tts.corrections, admin → Settings →
// TTS voice). The operator-extensible sibling of the built-in SUB/WAVE →
// "Subwave" rule below, for names and terms the engines mispronounce
// ("Hozier" → "Ho-zeer", "GHz" → "gigahertz"). Passed in as an argument —
// never read from settings here — so this module stays pure.
export interface SpeechCorrection {
  from: string;
  to: string;
}

// Matching is case-insensitive and word-bounded — but a \b anchor only where
// the rule's own edge is a word character, mirroring the SUB/WAVE rule's
// anchors: a rule for "live" must not fire inside "delivery", while a rule
// whose edge is a symbol ("Ke$ha") has no word boundary there to anchor on.
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

export function normalizeForSpeech(
  text: string,
  corrections?: readonly SpeechCorrection[],
): string {
  if (!text) return text;
  let t = text;

  // --- markdown / display markup (before unit rules, so `**76°F**` works) ---
  // Paired emphasis: keep the words, drop the marks. Bold before italic so
  // `**x**` doesn't leave stray asterisks for the italic pass to mis-pair.
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

  // --- HTML entities (a model quirk: encoded text in place of the glyph) ---
  // Decoded BEFORE the symbol rules so "&amp;" reads as "and", not "and amp;".
  // Only the entities that actually show up in chat-model output — a full
  // entity table would be scope creep for a spoken-text pass.
  t = t.replace(/&amp;/gi, '&');
  t = t.replace(/&(?:#0*39|apos|#0*8217|rsquo);/gi, "'");
  t = t.replace(/&(?:#0*34|quot|#0*8220|ldquo|#0*8221|rdquo);/gi, '"');
  t = t.replace(/&nbsp;/gi, ' ');

  // --- operator corrections (settings.tts.corrections) ---
  // After markdown/entity cleanup so a rule matches the readable text the
  // operator sees ("**Hozier**" still matches a "Hozier" rule), and BEFORE
  // the symbol rules so a correction can pre-empt a built-in expansion.
  if (corrections?.length) t = applyCorrections(t, corrections);

  // --- units and symbols (all keyed on an adjacent digit — conservative) ---
  t = t.replace(/(\d)\s*°\s*F\b/g, '$1 degrees Fahrenheit');
  t = t.replace(/(\d)\s*°\s*C\b/g, '$1 degrees Celsius');
  // Bare degree after a number ("45° today") — after the F/C passes so only
  // unitless degrees remain; a ° glued to any other letter is left alone.
  t = t.replace(/(\d)\s*°(?![A-Za-z])/g, '$1 degrees');
  t = t.replace(/(\d)\s*%/g, '$1 percent');
  // $ only when it PRECEDES a number — "Ke$ha" has no digit after the $ and
  // survives. Four passes, most specific first:
  // 1. The model already wrote the spoken form ("$5 million dollars", "$5
  //    dollars") — drop the symbol instead of speaking "dollars" twice.
  t = t.replace(
    new RegExp(`\\$(${DOLLAR_AMOUNT}${DOLLAR_MAGNITUDE})(?=\\s+dollars?\\b)`, 'gi'),
    '$1',
  );
  // 2./3. Compact magnitude suffixes ("$100k", "$5M", "$2bn") — expanded here
  //    so the letter can't glue onto "dollars" ("100 dollarsk"). Anchored on
  //    the $ AND the suffix, so a bare "5k run" is untouched.
  t = t.replace(new RegExp(`\\$(${DOLLAR_AMOUNT})k\\b`, 'gi'), '$1 thousand dollars');
  t = t.replace(new RegExp(`\\$(${DOLLAR_AMOUNT})m\\b`, 'gi'), '$1 million dollars');
  t = t.replace(new RegExp(`\\$(${DOLLAR_AMOUNT})(?:bn|b)\\b`, 'gi'), '$1 billion dollars');
  // 4. The plain form. The trailing (?!\w) leaves any OTHER glued suffix
  //    ("$100x") alone entirely — unspoken beats mangled.
  t = t.replace(
    new RegExp(`\\$(${DOLLAR_AMOUNT}${DOLLAR_MAGNITUDE})(?!\\w)`, 'gi'),
    '$1 dollars',
  );
  t = t.replace(/(\d)\s*mph\b/gi, '$1 miles per hour');
  t = t.replace(/(\d)\s*km\/h\b/gi, '$1 kilometers per hour');
  // "&" reads as "and" everywhere — that's the spoken form even inside names
  // ("Florence & the Machine", "R&B") — EXCEPT when it opens an entity-shaped
  // sequence we didn't decode above ("&lt;"): mangling those into "and lt;"
  // is worse than leaving them.
  t = t.replace(/\s*&(?!(?:#\d+|[a-zA-Z]+);)\s*/g, ' and ');

  // --- station branding: TTS engines read "SUB/WAVE" as "sub slash wave" ---
  t = t.replace(/\bSUB\s*(?:\/|slash)\s*WAVE\b/gi, 'Subwave');

  // Markup removal can leave doubled spaces; speech has no layout to preserve.
  return t.replace(/\s+/g, ' ').trim();
}
