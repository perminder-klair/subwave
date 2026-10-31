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

// Compared after folding (lower case, outer quotes/brackets/punctuation and
// inner runs of space or punctuation collapsed to one space). Only tokens that
// never occur as speech on their own: a one-word reply a guest could give in
// banter ("None.", "Empty.", "Example?", "Blank.") is speech, and dropping it
// would leave the host's next line answering nothing.
const STAND_IN_LINES = new Set([
  'placeholder', 'placeholder text', 'text placeholder', 'segment placeholder',
  'your text', 'your text here', 'text here', 'insert text', 'insert text here',
  'segment text', 'your line here',
  'tbd', 'tba', 'todo', 'tktk', 'fixme',
  'n a', 'null', 'undefined',
  'sample text', 'dummy text',
]);

const LOREM = /^lorem ipsum\b/;
const HAS_WORD = /[\p{L}\p{N}]/u;
// Template text left in brackets: "[Insert weather update here]",
// "{your text}", "<placeholder for the news segment>". A line wholly inside one
// bracket pair whose words start like a template's. A real aside in brackets
// starts with anything else and airs.
const BRACKETED = /^\s*(?:\[[^\]]*\]|\{[^}]*\}|<[^>]*>)\s*[.!?]?\s*$/;
const TEMPLATE_START = /^(?:placeholder|insert|your|tbd)\b/;

export function foldStandIn(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// The token that made `text` a stand-in, for the booth log, or null when the
// line is speech.
export function standInToken(text: string | null | undefined): string | null {
  const raw = String(text ?? '').trim();
  if (!raw) return null; // empty is the callers' own "no line" case, not this one
  if (!HAS_WORD.test(raw)) return raw.slice(0, 24);
  const folded = foldStandIn(raw);
  if (STAND_IN_LINES.has(folded) || LOREM.test(folded)) return folded.slice(0, 40);
  if (BRACKETED.test(raw) && TEMPLATE_START.test(folded)) return folded.slice(0, 40);
  return null;
}
