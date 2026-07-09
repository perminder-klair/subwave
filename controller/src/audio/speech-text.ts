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

// Magnitude words that ride between a $ amount and the spoken "dollars":
// "$5 million" must become "5 million dollars", not "5 dollars million".
const DOLLAR_MAGNITUDE = '(?:\\s+(?:thousand|million|billion|trillion))?';

export function normalizeForSpeech(text: string): string {
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

  // --- units and symbols (all keyed on an adjacent digit — conservative) ---
  t = t.replace(/(\d)\s*°\s*F\b/g, '$1 degrees Fahrenheit');
  t = t.replace(/(\d)\s*°\s*C\b/g, '$1 degrees Celsius');
  // Bare degree after a number ("45° today") — after the F/C passes so only
  // unitless degrees remain; a ° glued to any other letter is left alone.
  t = t.replace(/(\d)\s*°(?![A-Za-z])/g, '$1 degrees');
  t = t.replace(/(\d)\s*%/g, '$1 percent');
  // $ only when it PRECEDES a number — "Ke$ha" has no digit after the $ and
  // survives. The amount keeps its own formatting ("1,200", "12.50").
  t = t.replace(
    new RegExp(`\\$(\\d[\\d,]*(?:\\.\\d+)?${DOLLAR_MAGNITUDE})`, 'gi'),
    '$1 dollars',
  );
  t = t.replace(/(\d)\s*mph\b/gi, '$1 miles per hour');
  t = t.replace(/(\d)\s*km\/h\b/gi, '$1 kilometers per hour');
  // "&" reads as "and" everywhere — that's the spoken form even inside names
  // ("Florence & the Machine", "R&B").
  t = t.replace(/\s*&\s*/g, ' and ');

  // --- station branding: TTS engines read "SUB/WAVE" as "sub slash wave" ---
  t = t.replace(/\bSUB\s*(?:\/|slash)\s*WAVE\b/gi, 'Subwave');

  // Markup removal can leave doubled spaces; speech has no layout to preserve.
  return t.replace(/\s+/g, ' ').trim();
}
