// Is a generated line a stand-in rather than speech? A model told it must
// produce a line, but handed nothing to say, fills the required field with a
// form-filler token: the DJ read out the single word "placeholder" eleven
// times in a fortnight, from a prompt-only skill whose brief promised a web
// search it was never given. Schema validation passes such an answer, and the
// clock check has nothing to correct in it, so this is the one test for it.
//
// Whole-line only: a real sentence that happens to contain "placeholder" or
// "TBD" is speech and airs. A line with no letter or digit in any script
// ("...", "—") is a stand-in too, since it renders as a beat of silence
// dressed up as a segment. Verbatim operator text never reaches this check
// (the operator's words are theirs to air), and the caller drops the line
// rather than repairing it: there is nothing in a stand-in to repair.
//
// Judged on the line as the model wrote it AND on what normalizeForDisplay
// leaves of it, each with any leading label looked past. Either one alone misses
// half of these. Normalising empties a short bracket or a tag and only strips
// the brackets from a long one, so a template past it reads as prose; before it,
// "<p>TBD</p>" and "placeholder [laughs]" read as speech. Text it would empty
// had nothing to say, and that is a stand-in too. A line this test passes must
// stay passed in its display form: push() checks once and the render checks
// again, and by then a caller may have recorded the line as said.
//
// The label here is any name, not just the cast's ("DJ: placeholder", "Script:
// placeholder"), which is safe because it is only looked past for the verdict:
// stripSpeakerLabel owns what comes off the air, and strips known names only.

import { normalizeForDisplay, stripSpeakerLabel } from '../audio/speech-text.js';

// Compared after folding (lower case, outer quotes/brackets/punctuation and
// inner runs of space or punctuation collapsed to one space). Only tokens that
// never occur as speech on their own: a one-word reply a guest could give in
// banter ("None.", "Empty.", "Example?", "Blank.") is speech, and dropping it
// would leave the host's next line answering nothing.
const STAND_IN_LINES = new Set([
  'placeholder', 'placeholder text', 'text placeholder', 'segment placeholder',
  'your text', 'your text here', 'text here', 'insert text', 'insert text here',
  'segment text', 'your line here',
  'tbd', 'tba', 'tktk', 'fixme',
  'n a', 'undefined',
  'sample text', 'dummy text',
]);

// Real words in a language a persona may speak ("todo" is Spanish and
// Portuguese for everything, "null" German for zero), so only the capitals a
// form-filler writes count, matched before any case folding.
const STAND_IN_CAPITALS = new Set(['TODO', 'NULL']);

const LOREM = /^lorem ipsum\b/;
const HAS_WORD = /[\p{L}\p{N}]/u;
// Template text left in brackets: "[Insert weather update here]",
// "{your text}", "<placeholder for the news segment>". A line wholly inside one
// bracket pair whose words start like a template's. A real aside in brackets
// starts with anything else and airs.
const BRACKETED = /^\s*(?:\[[^\]]*\]|\{+[^}]*\}+|<[^>]*>)\s*[.!?]?\s*$/;
const TEMPLATE_START = /^(?:placeholder|insert|your|tbd)\b/;
// What a model wraps a whole line in: quotes, emphasis, a tag, a closing stop.
const WRAPPER = /^(?:[\s"'“”‘’«»*_`]|<\/?[a-z][^>]*>)+|(?:[\s"'“”‘’«»*_`.!?]|<\/?[a-z][^>]*>)+$/giu;
// No sentence punctuation in it: "That was Efdemin. The date: TBD." is speech.
const LABEL = /^[^:\r\n.,!?]{1,40}:\s+/;

function wordsOnly(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function foldStandIn(text: string): string {
  return wordsOnly(text).toLowerCase();
}

function judge(line: string): string | null {
  if (!HAS_WORD.test(line)) return line.slice(0, 24);
  const words = wordsOnly(line);
  if (STAND_IN_CAPITALS.has(words)) return words;
  const folded = foldStandIn(line);
  if (STAND_IN_LINES.has(folded) || LOREM.test(folded)) return folded.slice(0, 40);
  const bare = line.replace(WRAPPER, '');
  if (BRACKETED.test(bare) && TEMPLATE_START.test(foldStandIn(bare))) return foldStandIn(bare).slice(0, 40);
  return null;
}

// The token that made `text` a stand-in, for the booth log, or null when the
// line is speech.
export function standInToken(text: string | null | undefined): string | null {
  const raw = String(text ?? '').trim();
  if (!raw) return null; // empty is the callers' own "no line" case, not this one
  for (const written of new Set([raw, raw.replace(LABEL, '')])) {
    const shown = normalizeForDisplay(written);
    const token = judge(written) ?? (shown
      ? judge(shown) ?? judge(shown.replace(LABEL, ''))
      : foldStandIn(written).slice(0, 40));
    if (token) return token;
  }
  return null;
}

// The lines of an exchange the gate will let air: the same test
// announceExchange makes, for a caller that reports or records those lines.
export function withoutStandIns<Line extends { text: string }>(lines: readonly Line[], castNames: readonly string[]): Line[] {
  return lines.filter(line => !standInToken(stripSpeakerLabel(line.text, castNames)));
}
