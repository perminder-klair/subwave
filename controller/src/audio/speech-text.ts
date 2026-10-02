// Pure spoken-text normalizer — the defensive layer between generated radio
// copy and the TTS engines (issue #963). The DJ prompts already ask for
// "spoken words only", but a model can still emit display text — weather
// units, markdown emphasis, currency symbols — and engines read it literally
// ("seventy-six F", or an awkward beat where the asterisks were). Every
// booth-bound string converges on normalizeForSpeech() in audio/tts.ts, so
// the rules here must stay conservative: real artist/title text rides the
// same lines ("Ke$ha", "AC/DC", "P!nk" must survive untouched). Expressive
// engines may use bracketed performance cues, but they are structural input:
// closing, excess or trailing cues must never reach TTS.
//
// Plain quantities still belong to the engines. Years/decades are the narrow
// exception: engines can read "1967" as a quantity instead of a date (#1669).
// Spell those consistently for every engine, after operator corrections.
//
// TWO passes, and the split is load-bearing (issue #1186):
//
//   normalizeForDisplay() — markup + entity cleanup only. Safe for anything a
//     PERSON reads: the booth log, the session the DJ remembers, the player's
//     feed. Stripping `**bold**` makes a line more readable, never differently
//     spelled.
//   normalizeForSpeech()  — the above PLUS the pronunciation layer: operator
//     corrections, year/decade and unit/symbol expansion, SUB/WAVE → "Subwave".
//     These are spelled for an ENGINE's benefit, not a reader's — "Ye" reads
//     as "Yay" only so the voice says it right, and a listener seeing "Yay"
//     in the written line is a bug, not a feature. Speech-only spellings must
//     never be persisted anywhere a human sees them.
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
// Reuse each row's pattern across lines; weak keys release old settings when
// they are replaced. Check `from` on every use so in-place edits work too.
const correctionPatterns = new WeakMap<SpeechCorrection, { from: string; pattern: RegExp }>();

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
    let cached = correctionPatterns.get(c);
    if (cached?.from !== from) {
      cached = { from, pattern: correctionPattern(from) };
      correctionPatterns.set(c, cached);
    }
    t = t.replace(cached.pattern, () => to);
  }
  return t;
}

// Magnitude words that ride between a $ amount and the spoken "dollars":
// "$5 million" must become "5 million dollars", not "5 dollars million".
// The \b keeps "millionaire" from prefix-matching ("5 million dollarsaire").
const DOLLAR_MAGNITUDE = '(?:\\s+(?:thousand|million|billion|trillion)\\b)?';
// The $ amount itself: digits with their own formatting ("1,200", "12.50").
const DOLLAR_AMOUNT = '\\d[\\d,]*(?:\\.\\d+)?';

const SMALL_NUMBERS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const DECADES = ['', 'tens', 'twenties', 'thirties', 'forties', 'fifties', 'sixties', 'seventies', 'eighties', 'nineties'];
// Persona languages are free text; blank is the station's English default.
// Explicit non-English (including unknown labels) leaves dates to the engine.
const ENGLISH_LANGUAGE_RE = /^(?:english\b|en(?:$|[-_]))/i;
// 1800–2099 covers historical recordings/composers and near-future dates.
// Unicode boundaries also protect catalogue identifiers and longer digit runs.
const YEAR_RE = /(?<![\p{L}\p{N}_])((?:18|19|20)\d{2})(?:('?s)|\s*(?:-|to)\s*(\d{4}|\d{2}))?(?![\p{L}\p{N}_])/giu;
const SHORT_DECADE_RE = /(?<![\p{L}\p{N}_])('?)([1-9]0)'?s(?![\p{L}\p{N}_])/giu;
const SHORT_DURATION_RE = /^\s+(?:timeout|timer|delay|wait|interval|duration|countdown|limit)\b/i;
// Also covers phrases ending in "in the", "of the" and "from the".
const DECADE_CONTEXT_RE = /\b(?:the|early|mid|late|during)\s*$/i;
const IDENTIFIER_PREFIX_RE = /(?:\b(?:catalogue|catalog|cat\.|no\.|number|serial|model|room|flight|route|track\s+number|extension|ext\.?)|#)\s*$/i;
// Deliberately small: obvious counts, magnitudes and units, not a noun parser.
const PLURAL_COUNT_NOUNS = 'people|copies|records|tracks|songs|albums|items|units|dollars|cents|euros|pounds|seconds|minutes|hours|days|years|meters|metres|kilometers|kilometres|miles|feet|watts';
const MEASUREMENT_UNITS = 'milliseconds?|microseconds?|nanoseconds?|grams?|milligrams?|kilograms?|litres?|liters?|ns|us|µs|μs|ms|s|mg|g|kg|mm|cm|m|km|ml|l|mph|hz|khz|mhz|ghz|w|kw|mw|bpm|rpm|db';
const QUANTITY_SUFFIX_RE = new RegExp(`^(?:\\s*[%°\\p{Sc}]|\\s+(?:${PLURAL_COUNT_NOUNS}|dollar|cent|euro|pound|yen|thousand|million|billion|trillion|second|minute|hour|day|year|meter|metre|kilometer|kilometre|mile|watt|${MEASUREMENT_UNITS})\\b)`, 'iu');
// Only plural counts may follow an intervening word: "1984 vinyl records"
// is a quantity, while "the 1972 studio album" remains a date.
const PLURAL_QUANTITY_SUFFIX_RE = new RegExp(`^\\s+(?:[\\p{L}]+\\s+)?(?:${PLURAL_COUNT_NOUNS})\\b`, 'iu');

function twoDigitWords(n: number): string {
  if (n < 20) return SMALL_NUMBERS[n];
  const tens = TENS[Math.floor(n / 10)];
  return n % 10 ? `${tens}-${SMALL_NUMBERS[n % 10]}` : tens;
}

function yearWords(year: number): string {
  const last = year % 100;
  if (year >= 2000 && year < 2010) {
    return last ? `two thousand ${SMALL_NUMBERS[last]}` : 'two thousand';
  }
  const century = twoDigitWords(Math.floor(year / 100));
  if (!last) return `${century} hundred`;
  return `${century} ${last < 10 ? `oh-${SMALL_NUMBERS[last]}` : twoDigitWords(last)}`;
}

function decadeWords(year: number): string {
  if (year === 2000) return 'two thousands';
  const century = twoDigitWords(Math.floor(year / 100));
  return `${century} ${year % 100 ? DECADES[(year % 100) / 10] : 'hundreds'}`;
}

function isNumericContext(before: string, after: string): boolean {
  // Currency is still owned by the dollar rule below. Commas/decimal points
  // touching digits, clock colons and slash/hyphen date fragments stay numeric.
  return /(?:\p{Sc}\s*|[\d.,:/-])$/u.test(before)
    || /\d{2,}\s+$/.test(before)
    || /^\s+\d/.test(after)
    || IDENTIFIER_PREFIX_RE.test(before)
    || /\d\s+to\s*$/i.test(before)
    || /^[.,:]\d/.test(after)
    || /^\s*(?:[-/]|to\b)\s*\d/i.test(after);
}

function normalizeYears(text: string): string {
  const t = text.replace(YEAR_RE, (
    match, first: string, decade: string | undefined, end: string | undefined, offset: number,
  ) => {
    const before = text.slice(0, offset);
    const after = text.slice(offset + match.length);
    if (isNumericContext(before, after)
      || (!decade && (QUANTITY_SUFFIX_RE.test(after) || PLURAL_QUANTITY_SUFFIX_RE.test(after)))) return match;
    const year = Number(first);
    if (decade) {
      if (decade.startsWith("'")) {
        return year % 10 === 0 && DECADE_CONTEXT_RE.test(before)
          ? decadeWords(year) : `${yearWords(year)}'s`;
      }
      return year % 10 === 0 ? decadeWords(year) : match;
    }
    if (end) {
      const century = Math.floor(year / 100) * 100;
      const shortEnd = Number(end);
      const resolvedEnd = end.length === 2
        ? century + shortEnd + (shortEnd < year % 100 ? 100 : 0) : shortEnd;
      // Leave non-forward/out-of-range endpoints and multi-part dates alone.
      if (resolvedEnd <= year || resolvedEnd < 1800 || resolvedEnd > 2099) return match;
      const endWords = end.length === 2 && resolvedEnd < century + 100 && shortEnd >= 10
        ? twoDigitWords(shortEnd) : yearWords(resolvedEnd);
      return `${yearWords(year)} to ${endWords}`;
    }
    return yearWords(year);
  });
  return t.replace(SHORT_DECADE_RE, (match, quote: string, digits: string, offset: number) => {
    const before = t.slice(0, offset);
    const after = t.slice(offset + match.length);
    if (isNumericContext(before, after)) return match;
    // A bare "60s" may mean seconds. Require a date phrase or music context;
    // the leading apostrophe in "'60s" already makes the decade explicit.
    if (!quote) {
      if (SHORT_DURATION_RE.test(after)) return match;
      const dateContext = DECADE_CONTEXT_RE.test(before);
      const musicContext = /^(?:\s+(?:music|groove|sound|era|style|classics|hits|rock|pop|soul|jazz)\b|-inspired\b)/i.test(after);
      if (!dateContext && !musicContext) return match;
    }
    return DECADES[Number(digits) / 10];
  });
}

// Fish/Chatterbox performance cues are deliberately loose in vocabulary — the
// provider owns what it can express — but strict in position and purpose. A
// cue must have spoken words before the next cue (or the end), and a segment
// may carry at most two. Production directions are never useful TTS input:
// they invite the engine to narrate a fade, a track change or a timing note.
// This keeps a legitimate delivery change while dropping the common model
// failure of appending `[softly]` after its final sentence. Closing tags have
// no meaning to the supported engines and are always removed. Common bracketed
// title/version qualifiers are literal speech, not control syntax: deleting
// `[Live]` from a verified track title changes what the presenter says.
const PERFORMANCE_CUE_RE = /\[[^\]\r\n]{1,80}\]/g;
const SPOKEN_CHAR_RE = /[\p{L}\p{N}]/u;
const PRODUCTION_CUE_RE = /\b(?:cue|square|stage|direction|fad(?:e|es|ed|ing)|music|track|vocals?|sounds?|intro(?:duction)?|outro|transition|paus(?:e|es|ed|ing)|riff(?:ing)?|build(?:ing|s)?|seconds?|\d+s)\b/i;
const PRODUCTION_ACTION_RE = /\b(?:cue|stage|direction|fad(?:e|es|ed|ing)|intro(?:duction)?|outro|transition|paus(?:e|es|ed|ing)|riff(?:ing)?|build(?:ing|s)?|\d+s)\b/i;
const TITLE_QUALIFIER_RE = /^(?:live\b.*|deluxe\b.*|remaster(?:ed)?\b.*|radio edit\b.*|single edit\b.*|album version\b.*|original version\b.*|mono\b.*|stereo\b.*|acoustic\b.*|demo\b.*|bonus track\b.*|anniversary\b.*|expanded edition\b.*)$/i;
const BRACKETED_TITLE_RE = /^(?:untitled(?:\s+(?:track\s*)?(?:no\.?\s*)?#?\d+)?|track\s*(?:no\.?\s*)?#?\d+)$/i;
const TITLE_CONTEXT_RE = /\b(?:from|with|called|titled|track|song|album|record|version|mix|cut)\s*$/i;

function isTitleQualifier(body: string): boolean {
  return TITLE_QUALIFIER_RE.test(body) && !PRODUCTION_ACTION_RE.test(body);
}

function isPerformanceCue(body: string): boolean {
  return !isTitleQualifier(body)
    && !body.startsWith('/')
    && !body.startsWith('-')
    && !/\d/.test(body)
    && !PRODUCTION_CUE_RE.test(body);
}

// Real catalogue titles include names such as "[Untitled]". Preserve that
// known form, common edition qualifiers, and any bracketed value introduced as
// a title. Explicit title forms such as "from [Track 2]" are safe, but a title
// context never overrides a recognised production direction. Everything else
// keeps the existing loose performance-cue vocabulary and bounded removal.
function isLiteralBracket(body: string, prefix: string): boolean {
  return isTitleQualifier(body)
    || BRACKETED_TITLE_RE.test(body)
    || (TITLE_CONTEXT_RE.test(prefix) && !PRODUCTION_CUE_RE.test(body));
}

function stripUnmatchedCueBrackets(text: string): string {
  const cues = [...text.matchAll(PERFORMANCE_CUE_RE)];
  if (!cues.length) return text.replace(/[\[\]]/g, '');
  let out = '';
  let cursor = 0;
  for (const cue of cues) {
    const start = cue.index!;
    out += text.slice(cursor, start).replace(/[\[\]]/g, '');
    out += cue[0];
    cursor = start + cue[0].length;
  }
  return out + text.slice(cursor).replace(/[\[\]]/g, '');
}

export function sanitizePerformanceCues(text: string, maxCues = 2): string {
  if (!text) return text;
  const safeText = stripUnmatchedCueBrackets(text);
  const cues = [...safeText.matchAll(PERFORMANCE_CUE_RE)];
  if (!cues.length) return safeText.replace(/\s+/g, ' ').trim();

  let out = '';
  let cursor = 0;
  let kept = 0;
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i]!;
    const start = cue.index!;
    const end = start + cue[0].length;
    const nextStart = cues[i + 1]?.index ?? safeText.length;
    const body = cue[0].slice(1, -1).trim();
    const hasFollowingWords = SPOKEN_CHAR_RE.test(safeText.slice(end, nextStart));
    out += safeText.slice(cursor, start);
    if (isLiteralBracket(body, safeText.slice(0, start))) {
      out += cue[0];
    } else if (isPerformanceCue(body) && hasFollowingWords && kept < maxCues) {
      out += cue[0];
      kept += 1;
    } else if (!hasFollowingWords && nextStart === safeText.length) {
      // A terminal cue can carry only punctuation after its closing bracket
      // (`[sigh].`). The cue is not valid without following spoken words, and
      // retaining its punctuation leaves a dangling full stop in the booth
      // log and TTS input. Discard that suffix with the cue.
      cursor = safeText.length;
      continue;
    }
    cursor = end;
  }
  return (out + safeText.slice(cursor)).replace(/\s+/g, ' ').trim();
}

function literalizeBracketedSpeech(text: string): string {
  return text.replace(PERFORMANCE_CUE_RE, (cue, offset: number) => {
    const body = cue.slice(1, -1).trim();
    return isLiteralBracket(body, text.slice(0, offset)) ? body : cue;
  });
}

// Markup + entity cleanup — everything in the pipeline that is safe for a
// READER as well as an engine. Shared by both public passes so display and
// speech can never disagree about what the words are; only about how they're
// spelled out loud.
function stripMarkup(text: string): string {
  let t = text;

  // Invisible format controls and soft hyphens have no spoken value but can
  // confuse a provider tokenizer. NBSP is layout, so make it ordinary space.
  t = t.replace(/\u00a0/g, ' ');
  t = t.replace(/[\u00ad\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '');

  // --- markdown / display markup (before unit rules, so `**76°F**` works) ---
  // Keep the reader-facing label from a generated Markdown link; neither its
  // brackets nor URL belong in speech. This has to run before cue filtering.
  t = t.replace(/\[([^\]\r\n]+)\]\([^\)\r\n]+\)/g, '$1');
  // Strip actual HTML tags, but not ordinary comparison text such as "I <3
  // this". Models occasionally return HTML even after being told not to.
  t = t.replace(/<\/?[A-Za-z][^>\r\n]{0,120}>/g, '');
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
  // Leftover decorative marks that are never spoken. NOT lone underscores
  // (titles/filenames).
  t = t.replace(/[*`]/g, '');

  // --- HTML entities (a model quirk: encoded text in place of the glyph) ---
  // Decoded BEFORE the symbol rules so "&amp;" reads as "and", not "and amp;".
  // Only the entities that actually show up in chat-model output — a full
  // entity table would be scope creep for a spoken-text pass.
  t = t.replace(/&amp;/gi, '&');
  t = t.replace(/&(?:#0*39|apos|#0*8217|rsquo);/gi, "'");
  t = t.replace(/&(?:#0*34|quot|#0*8220|ldquo|#0*8221|rdquo);/gi, '"');
  t = t.replace(/&nbsp;/gi, ' ');

  return sanitizePerformanceCues(t);
}

// Markup removal can leave doubled spaces; neither speech nor a booth-log line
// has layout to preserve.
function collapseSpace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// Provider-facing punctuation. These substitutions are intentionally NOT part
// of normalizeForDisplay(): typographic quotes and dashes remain useful in the
// booth log, while the TTS request gets the conservative ASCII-safe form that
// previously lived in the Fish proxy.
function normalizeTtsPunctuation(text: string): string {
  let t = text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u2011/g, '-')
    .replace(/\u2026/g, '...');

  // En/figure dashes between digits are ranges, not pauses. Sentence dashes
  // stay intact: unlike commas, they reliably carry a natural pause in Fish
  // and other expressive engines.
  t = t.replace(/(?<=\d)\s*[\u2012\u2013]\s*(?=\d)/g, ' to ');
  // Double quotes are purely display punctuation and have caused inconsistent
  // cloud-TTS phrasing; apostrophes remain for contractions and possessives.
  t = t.replace(/"/g, '');
  return t.replace(/,(?:\s*,)+/g, ',');
}

// The READER's form of a line: markup and entities cleaned up, spelling left
// exactly as written. This is what gets logged, persisted to the session, and
// pushed to the player — see the two-pass note at the top of the file.
// A model that was told three times not to write speaker labels still writes
// them — "Iris: …", "Lucifer : …" — and the label is then READ ALOUD, so the
// listener hears a persona announce its own name before every line (#1707).
// The prompt instructions stay as the first line of defence; this is the check
// that makes the failure impossible rather than merely discouraged.
//
// ⚠️ It strips ONLY a name the caller already knows to be in the cast. A blanket
// "drop any leading Word:" would eat real speech — "Attention : voici le
// morceau" would lose its first word — and the cast is exactly what the caller
// has, because it is what routes each line to its voice.
// Supported grammar, deliberately narrow (PR #1715 review):
//   "Iris: hello"  "Iris : hello"  "«Iris»: hello"  — stripped when Iris is cast
//   "Iris:hello"                                    — NOT stripped: the space
//     after the colon is required, because "ratio:3" style text is not a label.
//   "**Iris:** hello"                               — reaches here as
//     "Iris: hello" only AFTER display normalization; stripping runs first, so
//     a bold label survives this pass. Prompt instructions remain the first
//     line of defence for that shape.
const SPEAKER_LABEL_RE = /^\s*([^:\r\n]+?)\s*:\s+/;
const SPEAKER_QUOTES: Readonly<Record<string, string>> = { '"': '"', "'": "'", '«': '»', '“': '”' };

function unquoteSpeaker(name: string): string {
  const trimmed = name.trim();
  const closing = SPEAKER_QUOTES[trimmed[0]!];
  if (!closing) return trimmed;
  // Accept an opening quote around the whole line as well as a quoted name.
  const rest = trimmed.slice(1).trim();
  return rest.endsWith(closing) ? rest.slice(0, -1).trim() : rest;
}

// Accent- and case-insensitive so "Solene:" still matches the persona Solène.
function foldName(name: string): string {
  return name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

export function stripSpeakerLabel(text: string, castNames: Iterable<string>): string {
  if (!text) return text;
  const known = new Set<string>();
  for (const n of castNames) {
    const folded = foldName(String(n || ''));
    if (folded) known.add(folded);
  }
  if (!known.size) return text;

  const m = SPEAKER_LABEL_RE.exec(text);
  if (!m) return text;
  if (!known.has(foldName(m[1]!)) && !known.has(foldName(unquoteSpeaker(m[1]!)))) return text;

  // One strip only: a second label deeper in the line is part of what was said
  // ("and then Iris: that was the moment"), not a routing artefact.
  const rest = text.slice(m[0].length);
  return rest.trim() ? rest : text;
}

export function normalizeForDisplay(text: string): string {
  if (!text) return text;
  return collapseSpace(stripMarkup(text));
}

export function normalizeForSpeech(
  text: string,
  corrections?: readonly SpeechCorrection[],
  language = '',
): string {
  if (!text) return text;
  let t = stripMarkup(text);

  // Keep literal bracket content in the reader-facing form, but remove the
  // cue-shaped delimiters before TTS so an expressive engine cannot interpret
  // a real title/version such as "[Untitled]" or "[Live]" as direction.
  t = literalizeBracketedSpeech(t);

  t = normalizeTtsPunctuation(t);

  // --- operator corrections (settings.tts.corrections) ---
  // After markdown/entity cleanup so a rule matches the readable text the
  // operator sees ("**Hozier**" still matches a "Hozier" rule), and BEFORE
  // the year/decade and symbol rules so a correction can pre-empt an expansion.
  if (corrections?.length) t = applyCorrections(t, corrections);

  // --- English years and decades (every engine, operator rules first) ---
  // Before currency/unit expansion: their original symbols identify quantities.
  const lang = language.trim();
  if (!lang || ENGLISH_LANGUAGE_RE.test(lang)) t = normalizeYears(t);

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

  return collapseSpace(t);
}

function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

// Convert a SPOKEN-word ceiling into the equivalent DISPLAY-word ceiling.
//
// The talk-within-the-intro budget (llm enforceIntroBudget) is a DURATION
// budget, so its word ceiling has to be counted on what the engine will
// actually read — the pronunciation layer changes the count ("$5 million" is
// two words that become four, a "Twenty88" → "twenty eighty-eight" rule turns
// one into three). But the trim itself has to land on the DISPLAY text, whose
// sentence and clause boundaries are the ones a listener will read back. So
// rather than budget one string and trim another, fold the difference into the
// pace scale: multiply by display÷spoken words and the ceiling stays a
// spoken-word ceiling while the cut lands on display words.
//
// 1 when either side is empty (nothing to scale) or the two agree — the
// overwhelmingly common case, which keeps an un-corrected station's budget
// byte-identical to before the split. Clamped to a sane band so one
// pathological rule (a correction that eats a whole sentence) can't collapse
// or balloon every line's budget.
export function spokenWordScale(display: string, spoken: string): number {
  const d = wordCount(display);
  const s = wordCount(spoken);
  if (!d || !s) return 1;
  return Math.min(4, Math.max(0.25, d / s));
}
