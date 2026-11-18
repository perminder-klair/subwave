// Does a listener-request line describe the track that will actually air?
// (#1918) The request agent chooses an id AND writes its ack/intro in the same
// answer, and nothing tied the words to the id: asked for "Michael Jackson
// please", it queued a real candidate — Madonna's "La Isla Bonita" — under an
// intro announcing Michael Jackson's "Billie Jean". The corrective re-pick only
// fires on an id outside the run's candidates, so a valid id under the wrong
// words went straight to air.
//
// The rule this module owns: a line may name the things the queued track could
// be confused with — what the listener asked for, another candidate the run
// surfaced, a quoted title — only if it ALSO names the queued track. A line that
// names nothing at all is vague, not wrong, and passes; so does one that owns a
// substitution ("no Michael Jackson tonight, but here's Madonna"). The same
// reading says whether the track is a STAND-IN for the ask at all
// (requestStandIn, #1979), which is what puts it under artist spacing; the
// stateless cascade, which has no lines when it chooses, asks the same of the
// matcher's reading (matchedRequestStandIn, #1993). Pure:
// the orchestration (one corrective re-pick, then plain copy) is the request
// agent's, in broadcast/dj-agent.ts. A pick's note is read by the same rule
// (#1978, misnamedPickNote below).
//
// Three sources of a wrong name, each chosen because it needs no world
// knowledge (the asked-for artist is often exactly the one the library lacks):
//
//   request          a run of the listener's own words the line repeats, read for
//                    the proper names in it — the incident's "Michael Jackson".
//                    A lowercase word splits a run rather than disqualifying
//                    it, so "some upbeat Michael Jackson" read back still yields
//                    the name. A name the line declines or uses as a reference
//                    ("no Michael Jackson tonight", "something like Daft
//                    Punk" — English cues only, see DECLINES) is not
//                    one. Any other dodge without naming the track trips it:
//                    the corrected line will then say what is really playing,
//                    which is the point.
//   candidate-*      another candidate's artist or title — the model describing
//                    the neighbour of the id it returned.
//   quoted-title     a quoted, title-cased span — "'Billie Jean'" — which radio
//                    copy only ever uses for a title.
//
// False positives are bounded by what counts as a NAME (see nameLike): the
// listener's name is never a claim ("Got you, Michael"), nor are the station's
// own — host, guests, station, a standalone "DJ" — lowercase words never
// are ("smooth and steady"), a lone capital at a sentence start is ambiguous and
// skipped, and the queued track's own names — every credited act, "The"-less
// forms, a title without its "(Remastered)" tail, the album — are masked out
// first. A word in the run's own genre tags is a genre, not a name ("a little
// Motown magic" for "some motown please"). Diacritics fold on both sides
// ("Beyonce" meets "Beyoncé"). A cover is not a mismatch: "Leonard Cohen's
// Hallelujah" over Jeff Buckley's version names the queued title, which grounds
// the request claim. Caseless scripts carry no capital, so they never make a
// request or candidate claim — an accepted miss, never a false alarm.
import { isNamedRequester, normalizeListenerText } from './request-guard.js';
import { artistParticipantKeys } from '../music/recency.js';
import { composedEnglishFits } from '../broadcast/announce-line.js';

export interface ClaimTrack {
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  // The slim projection's comma-joined genre tags ("Hip-Hop, Rap").
  genre?: string | null;
}

export interface ClaimContext {
  // The track the line will air over.
  track: ClaimTrack;
  // The listener's words, already cleaned by the route.
  requestText?: string | null;
  // The listener's screened name; never a claim.
  requester?: string | null;
  // The station's own names — the on-air host, any guest on the roster, the
  // station itself. Never a claim either, bare or as "DJ <name>".
  stationNames?: Iterable<string | null | undefined>;
  // Every OTHER candidate the run surfaced.
  others?: Iterable<ClaimTrack | null | undefined>;
  // Names the writer was handed as context rather than to choose from — the
  // track a pick follows, the recent plays, the show's own name and brief
  // (#1978). A line may say them without claiming a track. Unlike
  // stationNames they take no "DJ" form.
  references?: Iterable<string | null | undefined>;
  // What the run itself looked up by name (requestLookups, or the cascade's
  // matchedRequestLookups). Read only by the stand-in readings: a track the
  // run's own lookup names is the ask.
  lookups?: Iterable<string | null | undefined>;
  // The track on air when the listener asked. Read only by the stand-in
  // readings: an ask that points at it ("more of this", DEICTIC) names its
  // credit.
  onAir?: ClaimTrack | null;
}

// Which writer's line is read. A request line (#1918) keeps the rules its probe
// measured; a pick NOTE (#1978) is read two ways wider, both for candidate
// claims only — see possessiveLead and COMPARES.
type ClaimMode = 'request' | 'pick-note';

export type ClaimSource = 'request' | 'candidate-artist' | 'candidate-title' | 'quoted-title';

export interface LineClaim {
  source: ClaimSource;
  // The claim as the line spells it, for the operator log and the lookup.
  text: string;
}

export interface MisnamedLine {
  field: 'ack' | 'intro';
  claims: LineClaim[];
}

interface Tok {
  key: string;
  // First letter upper (true), lower (false), or caseless — digits, Gurmukhi,
  // Han — (null).
  capital: boolean | null;
  sentenceStart: boolean;
  start: number;
  end: number;
}

// `&`/`+` are words of their own, read as "and", so "Simon & Garfunkel" and
// "Simon and Garfunkel" key alike. Combining marks stay inside a word (Indic
// vowel signs) and are folded out of the key.
const TOKEN = /[\p{L}\p{N}\p{M}]+|[&+]/gu;
const SENTENCE_BREAK = /[.!?…:;\n]/u;

function fold(word: string): string {
  return word.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

function tokenize(raw: string | null | undefined): Tok[] {
  const text = normalizeListenerText(raw);
  const out: Tok[] = [];
  let prevEnd = 0;
  for (const m of text.matchAll(TOKEN)) {
    const word = m[0];
    const start = m.index ?? 0;
    const sentenceStart = out.length === 0 || SENTENCE_BREAK.test(text.slice(prevEnd, start));
    prevEnd = start + word.length;
    if (word === '&' || word === '+') {
      out.push({ key: 'and', capital: null, sentenceStart, start, end: prevEnd });
      continue;
    }
    const key = fold(word);
    if (!key) continue;
    const first = [...word][0]!;
    const capital = first.toLowerCase() === first.toUpperCase() ? null : first === first.toUpperCase();
    out.push({ key, capital, sentenceStart, start, end: prevEnd });
  }
  return out;
}

function keysOf(raw: string | null | undefined): string[] {
  return tokenize(raw).map((t) => t.key);
}

// Connectives a title-cased name keeps in lower case ("Sweet Child o' Mine",
// "Earth, Wind and Fire"). They never make a span a name on their own.
const MINOR = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'o', 'n', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'from', 'vs',
  'de', 'la', 'le', 'les', 'el', 'los', 'las', 'y', 'da', 'di', 'du', 'del', 'van', 'von', 'der', 'den', 'des',
  'feat', 'ft', 'featuring',
]);

// Request filler trimmed off the ENDS of a shared run, so "some Michael Jackson
// please" keys as the name alone.
const FILLER = new Set([
  ...MINOR,
  'please', 'pls', 'plz', 'play', 'some', 'something', 'anything', 'any', 'more', 'again', 'now', 'just',
  'song', 'songs', 'track', 'tracks', 'tune', 'tunes', 'music', 'me', 'my', 'you', 'your', 'i', 'can', 'could',
]);

// A span reads as a proper name when no content word is lower case and at least
// one capital sits mid-sentence. A lone sentence-initial capital is ambiguous —
// "Smooth vibes for you" — so it is never enough.
function nameLike(toks: Tok[]): boolean {
  let midCapital = false;
  for (const t of toks) {
    if (MINOR.has(t.key)) continue;
    if (t.capital === false) return false;
    if (t.capital === true && !t.sentenceStart) midCapital = true;
  }
  return midCapital;
}

// "Teardrop's hush…": a pick note opens on its subject, and a possessive is the
// one sentence-start shape that reads as a name rather than an adjective
// ("Smooth handoff…"). Pick notes only. Its price, measured: a common-word
// title in the run ("Tonight") under a note opening "Tonight's mood…". The
// same shape after an adverb or pronoun is a contraction, never a possessive
// ("Here's a darker turn", "Something's off-kilter"), and real titles share
// those words ("Here", "Something"), so they stay ambiguous like any other
// lone sentence-start capital.
const CONTRACTED = new Set([
  'here', 'there', 'that', 'what', 'who', 'where', 'when', 'how', 'let',
  'something', 'nothing', 'everything', 'anything', 'someone', 'everyone', 'somebody', 'everybody', 'nobody',
]);

function possessiveLead(text: string, toks: Tok[]): boolean {
  if (toks.length === 1 && CONTRACTED.has(toks[0]!.key)) return false;
  return toks.every((t) => MINOR.has(t.key) || t.capital === true)
    && /^['’]s\b/u.test(text.slice(toks[toks.length - 1]!.end));
}

function occurrences(line: Tok[], phrase: string[]): number[] {
  const at: number[] = [];
  if (!phrase.length) return at;
  for (let i = 0; i + phrase.length <= line.length; i++) {
    let ok = true;
    for (let k = 0; k < phrase.length && ok; k++) ok = line[i + k]!.key === phrase[k];
    if (ok) at.push(i);
  }
  return at;
}

function contains(haystack: string[], needle: string[]): boolean {
  if (!needle.length || needle.length > haystack.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((k, j) => haystack[i + j] === k)) return true;
  }
  return false;
}

function uniquePhrases(list: string[][]): string[][] {
  const seen = new Set<string>();
  return list.filter((p) => {
    const id = p.join(' ');
    if (!p.length || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

// "The Killers" is also said "Killers".
function withoutArticle(p: string[]): string[][] {
  return p.length > 1 && p[0] === 'the' ? [p, p.slice(1)] : [p];
}

// A title as a line might say it: whole, without bracketed tails ("(Remastered
// 2011)", "[Live]", a "(feat. …)" credit) and without a " - Single Version"
// dash tail.
function titlePhrases(title: string | null | undefined): string[][] {
  const raw = normalizeListenerText(title).trim();
  if (!raw) return [];
  const forms = [
    raw,
    raw.replace(/\s*[([][^)\]]*[)\]]\s*/gu, ' '),
    raw.split(/\s+[-–—]\s+/u)[0]!,
  ];
  return uniquePhrases(forms.flatMap((f) => withoutArticle(keysOf(f))));
}

// Every act a credit could be introduced by: the whole credit, each featured
// act, and each side of a join. Splitting wider than the blocklist ever would
// is right HERE: a wrong split can only over-ground a line (let it pass), never
// raise a false alarm.
function artistPhrases(artist: string | null | undefined): string[][] {
  const parts = new Set<string>();
  const whole = normalizeListenerText(artist).trim();
  if (!whole) return [];
  parts.add(whole);
  for (const act of artistParticipantKeys(whole)) {
    parts.add(act);
    for (const side of act.split(/\s+(?:&|\+|and|x|with|vs\.?)\s+|\s*[,/;•·|]\s*/u)) parts.add(side);
  }
  return uniquePhrases([...parts].flatMap((p) => withoutArticle(keysOf(p))))
    .filter((p) => p.join('').length >= 2);
}

// Did the line say this name? A one-word name said in lower case does not
// count ("hello there" is not the song "Hello").
function names(line: Tok[], phrases: string[][]): boolean {
  return phrases.some((p) => occurrences(line, p).some((i) => p.length > 1 || line[i]!.capital !== false));
}

// An honest substitution names the ask to decline it or to use it as a
// reference, and the frame prompt asks for exactly that: "no Michael Jackson
// tonight", "we don't have any Prince", "couldn't find Adele", "Adele isn't in
// the crates", "not Beyoncé, but…", "something like Daft Punk", "if you like
// Coldplay". A request claim in one of those slots is not a claim. ENGLISH
// ONLY, and deliberately this short: a cue list grows into an NLP heuristic,
// and another language's "no tenemos a X" still reads as a claim — a false
// alarm costing a corrective call, never a lie let through. Each row is the
// text right before the name and right after it (null: anything).
const DECLINES: Array<[RegExp | null, RegExp | null]> = [
  // "don't have any Prince", "couldn't find Adele", "something like Daft
  // Punk", "if you like the Beatles" — a filler word may sit between.
  [/\b(?:don['’]?t have|do not have|(?:couldn['’]?t|could not|can['’]?t|cannot) find|something like|if you like)(?:\s+(?:any|some|more|the))*\s+$/iu, null],
  // "no Michael Jackson tonight". "No" is a determiner as often as a decline
  // ("no Michael Jackson fan can resist…"), so only where the name ends the
  // clause or "tonight", "in the crates" and the like follow.
  [/\bno(?:\s+more)?\s+$/iu, /^(?:\s*(?:[,.;:!?—–…]|$)|\s+(?:tonight|today|in|on|here|for|but)\b)/iu],
  // "not Beyoncé tonight, but…"
  [/\bnot\s+$/iu, /^\W*(?:(?:tonight|today)\W+)?but\b/iu],
  // "Adele isn't in the crates", "Michael Jackson's not in the library"
  [null, /^(?:['’]s not|\s+(?:is|are)(?:n['’]?t| not)) in (?:the |my |our )?(?:crates?|library|collection)\b/iu],
];

// A pick note naming another act to COMPARE ("a Portishead-like gloom",
// "harder than Def Leppard") says the pick is not that act, so the name is a
// reference (#1978). Pick notes only: a request line that dodges the ask this
// way still owes the listener the queued track's name. Same shape and the same
// brevity rule as DECLINES.
const COMPARES: Array<[RegExp | null, RegExp | null]> = [
  [null, /^-(?:style|like|esque|adjacent|ish|inspired|tinged|sized)\b/iu],
  [/\b(?:like|à la|a la|than|in the vein of|in the spirit of)(?:\s+the)?\s+$/iu, null],
];

function cued(table: Array<[RegExp | null, RegExp | null]>, text: string, start: number, end: number): boolean {
  return table.some(([before, after]) => (!before || before.test(text.slice(0, start)))
    && (!after || after.test(text.slice(end))));
}

function declined(text: string, start: number, end: number): boolean {
  return cued(DECLINES, text, start, end);
}

function surface(text: string, toks: Tok[]): string {
  return toks.length ? text.slice(toks[0]!.start, toks[toks.length - 1]!.end) : '';
}

// Quoted spans: "…", “…”, «…», „…“ and '…'/‘…’. A single quote opens only
// before a letter and away from a word ("here's" and "'80s" never open one),
// and an apostrophe followed by a letter stays inside ("'Don't Stop'").
const QUOTED: RegExp[] = [
  /"([^"\n]{1,120})"/gu,
  /“([^”\n]{1,120})”/gu,
  /«([^»\n]{1,120})»/gu,
  /„([^“”\n]{1,120})[“”]/gu,
  /(?<![\p{L}\p{N}])['‘](?=\p{L})((?:[^'‘’\n]|['’](?=\p{L})){1,120}?)['’](?![\p{L}\p{N}])/gu,
];
const QUOTED_MAX_WORDS = 12;

function quotedSpans(text: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  for (const re of QUOTED) {
    for (const m of text.matchAll(re)) {
      const start = (m.index ?? 0) + m[0].indexOf(m[1]!);
      out.push({ start, end: start + m[1]!.length });
    }
  }
  return out;
}

// `declines` are the request names the line declines or uses as a reference
// (DECLINES) — never claims, but the mark of a stand-in (requestStandIn).
interface ReadClaims {
  claims: LineClaim[]; declines: LineClaim[]; titleNamed: boolean; artistNamed: boolean;
}

export function lineClaims(line: string | null | undefined, ctx: ClaimContext): ReadClaims {
  return readClaims(line, ctx, 'request');
}

function readClaims(line: string | null | undefined, ctx: ClaimContext, mode: ClaimMode): ReadClaims {
  const text = normalizeListenerText(line);
  const toks = tokenize(text);
  const titles = titlePhrases(ctx.track?.title);
  const artists = artistPhrases(ctx.track?.artist);
  const own = [...titles, ...artists, ...titlePhrases(ctx.track?.album)];
  const titleNamed = names(toks, titles);
  const artistNamed = names(toks, artists);
  const declines: LineClaim[] = [];
  if (!toks.length) return { claims: [], declines, titleNamed, artistNamed };

  // The queued track's own names, masked out before anything is read as a claim.
  const masked = new Array<boolean>(toks.length).fill(false);
  for (const p of own) {
    for (const i of occurrences(toks, p)) for (let k = 0; k < p.length; k++) masked[i + k] = true;
  }
  // Names a line may say without claiming a track: the listener's, the
  // station's own (the host greets "hey DJ Marlowe" back), and "DJ" standalone
  // ("Your DJ has you covered" for "hey DJ, play something chill"). A span
  // inside one is not a claim; "DJ Shadow" is not inside ["dj"], so it still is.
  // Then the writer's references — the track a pick follows, recent plays.
  const exempt: string[][] = [['dj']];
  if (isNamedRequester(ctx.requester)) exempt.push(keysOf(ctx.requester));
  for (const name of ctx.stationNames ?? []) {
    const keys = keysOf(name);
    if (keys.length) exempt.push(keys, ['dj', ...keys]);
  }
  for (const name of ctx.references ?? []) {
    const keys = keysOf(name);
    if (keys.length) exempt.push(keys);
  }
  const isExempt = (keys: string[]) => exempt.some((name) => contains(name, keys));
  const others = [...(ctx.others ?? [])];

  // Words in the run's own genre tags — the queued track's and every other
  // candidate's. The commonest request is a genre, a language or a season
  // ("some motown please", "punjabi songs", "christmas music"), its ack reads
  // the word back capitalised ("a little Motown magic"), and that ack often
  // names no track: read as a name, it cost a corrective model call and a
  // library search to fix a line that was true. The tags tell a genre from an
  // artist with no world knowledge. Word by word, so a "Christmas Music" tag
  // covers "Christmas". The request source only: a candidate's TITLE may share
  // a genre word ("Soul Man") and is still a name.
  const genreWords = new Set<string>();
  for (const c of [ctx.track, ...others]) {
    for (const k of keysOf(c?.genre)) if (!MINOR.has(k)) genreWords.add(k);
  }

  const claims: LineClaim[] = [];
  const claimed = new Set<string>();
  const add = (source: ClaimSource, span: Tok[]) => {
    const id = `${source}:${span[0]!.start}:${span[span.length - 1]!.end}`;
    if (claimed.has(id)) return;
    claimed.add(id);
    claims.push({ source, text: surface(text, span) });
  };

  // 1. Runs of the listener's words the line repeats, read for the names in
  // them. A lowercase content word ends a name, not the claim: judged whole,
  // "some upbeat Michael Jackson" read back failed nameLike on "upbeat", and so
  // did a possessive ("Michael Jackson's Thriller" keys its "s" lower case). A
  // genre word ends one the same way, however it is cased.
  const req = keysOf(ctx.requestText);
  const readName = (from: number, to: number) => {
    let a = from;
    let b = to;
    while (a <= b && FILLER.has(toks[a]!.key)) a++;
    while (b >= a && FILLER.has(toks[b]!.key)) b--;
    if (a > b) return;
    const span = toks.slice(a, b + 1);
    if (!nameLike(span)) return;
    if (isExempt(span.map((t) => t.key))) return;
    if (declined(text, span[0]!.start, span[span.length - 1]!.end)) {
      declines.push({ source: 'request', text: surface(text, span) });
      return;
    }
    add('request', span);
  };
  for (let i = 0; i < toks.length; i++) {
    for (let j = 0; j < req.length; j++) {
      if (masked[i] || toks[i]!.key !== req[j]) continue;
      // Only from where a run STARTS, so each run is read once.
      if (i > 0 && j > 0 && !masked[i - 1] && toks[i - 1]!.key === req[j - 1]) continue;
      let end = i;
      while (end + 1 < toks.length && j + (end + 1 - i) < req.length
        && !masked[end + 1] && toks[end + 1]!.key === req[j + (end + 1 - i)]) end++;
      let from = i;
      for (let k = i; k <= end; k++) {
        const word = toks[k]!;
        if (!genreWords.has(word.key) && (word.capital !== false || MINOR.has(word.key))) continue;
        readName(from, k - 1);
        from = k + 1;
      }
      readName(from, end);
    }
  }

  // 2. Another candidate's artist or title. A pick note also opens on a
  // possessive name and names acts to compare against (possessiveLead,
  // COMPARES).
  const pickNote = mode === 'pick-note';
  const ownIds = new Set(own.map((p) => p.join(' ')));
  const typed: Array<[ClaimSource, string[][]]> = [['candidate-artist', []], ['candidate-title', []]];
  for (const o of others) {
    if (!o) continue;
    typed[0]![1].push(...artistPhrases(o.artist));
    typed[1]![1].push(...titlePhrases(o.title));
  }
  for (const [source, list] of typed) {
    for (const p of uniquePhrases(list)) {
      if (ownIds.has(p.join(' ')) || p.join('').length < 3) continue;
      for (const i of occurrences(toks, p)) {
        const span = toks.slice(i, i + p.length);
        if (masked.slice(i, i + p.length).some(Boolean)) continue;
        if (!nameLike(span) && !(pickNote && possessiveLead(text, span))) continue;
        if (isExempt(p)) continue;
        if (pickNote && cued(COMPARES, text, span[0]!.start, span[span.length - 1]!.end)) continue;
        add(source, span);
      }
    }
  }

  // 3. A quoted title that is none of the queued track's names.
  for (const q of quotedSpans(text)) {
    const idx = toks.map((t, i) => (t.start >= q.start && t.end <= q.end ? i : -1)).filter((i) => i >= 0);
    if (!idx.length || idx.length > QUOTED_MAX_WORDS) continue;
    const span = idx.map((i) => toks[i]!);
    if (span[0]!.capital === false || !span.some((t) => t.capital === true)) continue;
    if (idx.some((i) => masked[i])) continue;
    if (isExempt(span.map((t) => t.key))) continue;
    add('quoted-title', span);
  }

  return { claims, declines, titleNamed, artistNamed };
}

// The claims that make a line wrong about the queued track. A wrong ARTIST is
// excused only by naming the queued artist, a wrong TITLE only by naming the
// queued title; the listener's own words, which could be either, by naming
// either. Empty means the line may air.
export function misnamedClaims(line: string | null | undefined, ctx: ClaimContext): LineClaim[] {
  return unexcused(lineClaims(line, ctx));
}

function unexcused({ claims, titleNamed, artistNamed }: ReadClaims): LineClaim[] {
  return claims.filter((c) => {
    if (c.source === 'request') return !titleNamed && !artistNamed;
    if (c.source === 'candidate-artist') return !artistNamed;
    return !titleNamed;
  });
}

// Both lines of a request answer: the intro airs, and the ack is what the
// listener reads back. Empty means both describe the queued track.
export function misnamedRequestLines(
  lines: { ack?: string | null; intro?: string | null },
  ctx: ClaimContext,
): MisnamedLine[] {
  const out: MisnamedLine[] = [];
  for (const field of ['intro', 'ack'] as const) {
    const claims = misnamedClaims(lines[field], ctx);
    if (claims.length) out.push({ field, claims });
  }
  return out;
}

// Whether a misnamed answer earns the corrective re-pick, and with it the
// lookup. Only the INTRO airs. An ack that misnames under a fine — or absent —
// intro is read text, and the plain ack makes it true outright, so it costs no
// model call and no library search: most of the false alarms left are
// ack-shaped (a weekday, a dedication read back), and each one cost a call.
// The price: an ack-only miss never reaches the lookup, so an asked-for artist
// the library does have is not offered — the plain ack still says what plays.
export function claimEarnsRepick(misnamed: MisnamedLine[]): boolean {
  return misnamed.some((m) => m.field === 'intro');
}

// The pick path's half of the rule (#1978). A pick's model writes its id and
// its note in one answer, as the request agent does, and only the id was
// checked: searchLibrary answers a named search with several tracks by that
// artist, the harness accepts any of them, and the note can describe the
// neighbour of the id it returned. The Booth shows that note under the queued
// track, and the next pick reads it back as its memory of what aired.
//
// Read the MODEL'S words, never the controller's composed sentence: its
// verified "“Title” by Artist" prefix would ground every line. There is no
// request text, so the claims are the other candidates and quoted titles; the
// track the pick follows and the recent plays are references, since "after
// Porcelain's hush" is the commonest honest name in a note. The remedy is the
// one claimEarnsRepick takes for an ack: a note is read, never aired, so a
// misnamed one becomes the route's plain copy with no model call, and the
// track — which passed every guard — stands.
export function misnamedPickNote(
  note: string | null | undefined,
  ctx: Omit<ClaimContext, 'requestText' | 'requester'>,
): LineClaim[] {
  return unexcused(readClaims(note, { ...ctx, requestText: null, requester: null }, 'pick-note'));
}

// Tools that already look a NAMED artist or title up in the library.
const LOOKUP_TOOLS = new Set(['searchLibrary', 'identifyRequestedTrack', 'topSongsByArtist', 'recentByArtist']);

// The lookup the agent skipped. When a misnamed line repeats what the listener
// asked for and the run never searched for anything, the corrective re-pick
// gets one library search for that name, so a listener who asked for an artist
// the library HAS can still get them. Null when the run already looked
// something up (a second search would only repeat it) or no request claim is
// in play. The longest claim wins: it is the most specific name.
export function claimLookupQuery(
  misnamed: MisnamedLine[],
  toolCalls: ReadonlyArray<{ name?: string | null } | null | undefined> | null | undefined,
): string | null {
  if ((toolCalls ?? []).some((c) => !!c?.name && LOOKUP_TOOLS.has(c.name))) return null;
  let best: string | null = null;
  for (const m of misnamed) {
    for (const c of m.claims) {
      if (c.source === 'request' && c.text.length > (best?.length ?? 0)) best = c.text;
    }
  }
  return best;
}

// What the run itself looked up by NAME (#1979): the library searches it ran,
// the artists whose catalogue it walked, and the tracks identifyRequestedTrack
// resolved a description to. The agent reads a nickname with the world
// knowledge this module lacks — "the King" searched as "Elvis Presley" — so a
// track its own lookup names is the ask as the agent understood it.
//
// A lookup in the LISTENER's spelling also names what it found. Local models
// copy the listener's words into the query ("Moosewala", "Tupac"), and the
// library answers in its own spelling — searchLibrary's artist retry exists
// for exactly that — so with `requestText` the credits such a call returned
// are lookups too. Never searchLibrary's vibe fallback (`via: 'vibe'`): those
// are lookalikes, and an absent artist's lookalikes can include the very
// artist on air — the #1918 shape, which must stay a stand-in.
const NAMED_LOOKUP_ARG = new Map([['searchLibrary', 'query'], ['topSongsByArtist', 'artist'], ['recentByArtist', 'artist']]);

export function requestLookups(
  toolCalls: ReadonlyArray<{ name?: string | null; args?: unknown; result?: unknown } | null | undefined> | null | undefined,
  requestText?: string | null,
): string[] {
  const req = keysOf(requestText);
  const out: string[] = [];
  for (const c of toolCalls ?? []) {
    const arg = c?.name ? NAMED_LOOKUP_ARG.get(c.name) : undefined;
    const value = arg ? (c?.args as Record<string, unknown> | null)?.[arg] : undefined;
    if (typeof value === 'string') out.push(value, ...listenerWordCredits(value, literalTracks(c?.result), req));
    if (c?.name !== 'identifyRequestedTrack') continue;
    const found = (c.result as { candidates?: unknown } | null)?.candidates;
    for (const t of Array.isArray(found) ? found : []) out.push(`${t?.artist ?? ''} ${t?.title ?? ''}`);
  }
  return out;
}

// What the stateless cascade's term search found in the listener's own
// spelling (#1993): requestLookups' rule for the searches routes/request.ts
// step 2c runs. The matcher copies the listener's spelling into a term as a
// local model copies it into a query ("Tupac", "Pink"), and search3 answers
// in the library's ("2Pac", "P!nk"), which no spelling rule of asksForTrack
// reaches; the credits such a search returned are the ask. A term in other
// words — the matcher's own canonical spelling — names only itself.
export function matchedRequestLookups(
  searches: Iterable<{ term: string; hits: readonly unknown[] | null | undefined }>,
  requestText: string | null | undefined,
): string[] {
  const req = keysOf(requestText);
  return [...searches].flatMap(({ term, hits }) => listenerWordCredits(term, hits ?? [], req));
}

// The credits a lookup in the listener's own words answered with: the
// library's spelling of what they asked for.
function listenerWordCredits(query: string, tracks: readonly unknown[], req: string[]): string[] {
  if (!inListenerWords(query, req)) return [];
  return tracks.map((t) => (t as { artist?: unknown } | null)?.artist).filter((a): a is string => typeof a === 'string');
}

// A query is the listener's own words when every word in it, filler aside, is
// one they wrote — or a letter off one.
function inListenerWords(query: string, req: string[]): boolean {
  const words = keysOf(query).filter((k) => !FILLER.has(k));
  return words.length > 0 && words.every((k) => req.some((w) => saysWord(w, k)));
}

// The tracks a lookup answered with: a plain list, or a labelled one whose
// literal matches were all filtered — but not a vibe search's neighbours.
function literalTracks(result: unknown): any[] {
  if (Array.isArray(result)) return result;
  const labelled = result as { tracks?: unknown; via?: unknown } | null;
  return labelled?.via !== 'vibe' && Array.isArray(labelled?.tracks) ? labelled.tracks : [];
}

// Is the track a STAND-IN for what the listener named (#1979)? Requests are
// exempt from artist spacing because an explicit ask wins, and a stand-in is
// not the ask: the listener named an artist or a title, the library could not
// meet it, and the agent chose something else — in #1918, Madonna straight
// after Madonna for "Michael Jackson please". Whose track stands in is the
// DJ's choice, so the DJ's spacing rule applies to it
// (broadcast/dj-agent/artist-guard.ts); the listener's own ask never does.
//
// The evidence is the run's OWN lines — every ack and intro it wrote, replaced
// ones included — read against the track by this module's rules: a line that
// declines a name the listener used or uses it as a reference (DECLINES, the
// honest substitution the frame prompt asks for), or one that names the
// listener's words over a track it does not name (the #1918 lie, which still
// says what they asked for after plain copy has replaced it). Not the request
// text's own capitals: a nickname, an abbreviation or a typo ("more MJ
// please", "Madona") reads as an unmet name over the very artist asked for,
// and a test wrong in that direction steers a genuine request away from its
// artist. The lie's evidence has the same blind spot — a line that reads the
// listener's "MJ" back says the listener's words over a track it does not
// name by its library name — so the ask is excused FIRST, by the listener's
// words (asksForTrack, which reads abbreviations and typos) or by the run's
// own named lookups (requestLookups, which carry the agent's reading of a
// nickname), or — for an ask that points at what is playing ("more of this")
// — by the on-air credit, so no word a line reads back can space an answer
// by that artist. A line that DECLINES a name of the listener's still does:
// it says they asked for someone else ("keep it going with some Michael
// Jackson" answered "No Michael Jackson tonight"), the #1918 shape. Nor is a
// word the request uses for something other than music (unaskedSlots)
// evidence. A substitution owned without a name ("can't do that one") is an
// accepted miss: the track airs as it always did.
export function requestStandIn(lines: Iterable<string | null | undefined>, ctx: ClaimContext): boolean {
  const asked = [ctx.requestText, ...(ctx.lookups ?? [])];
  if (asked.some((a) => asksForTrack(a, ctx.track))) return false;
  const onAirAsked = !!ctx.onAir && pointsAtOnAir(ctx.requestText) && asksForTrack(ctx.onAir.artist, ctx.track);
  const asksName = askedNameTest(ctx.requestText);
  const asks = (c: LineClaim) => asksName(c.text);
  // Only the request's own words are evidence, so the other candidates count
  // only for their genre tags; their names would be read as claims nobody
  // looks at, once per candidate the spacing pass asks about.
  const byGenre = { ...ctx, others: [...(ctx.others ?? [])].map((o) => ({ genre: o?.genre })) };
  for (const line of lines) {
    const read = lineClaims(line, byGenre);
    if (read.declines.some(asks) || (!onAirAsked && unexcused(read).some((c) => c.source === 'request' && asks(c)))) return true;
  }
  return false;
}

// The stand-in reading for the stateless cascade (#1993): is a pool track a
// STAND-IN for what its matcher read the listener as naming? routes/request.ts
// draws from a pool before any line is written — its ack and intro come after
// the pick — so there are no lines to read. Its evidence is the matcher's
// reading instead, `named`: the artist and the artist names or song titles it
// searched for. That reading is the cascade's own named lookup, the
// counterpart of requestLookups, so a track any of it names is the ask, as is
// one the listener's words name (asksForTrack, with its spellings, initials
// and joined credits) or one `lookups` names (matchedRequestLookups: what a
// search in the listener's spelling found, which excuses and never asks). Any
// other track stands in when the matcher named music at all: an ask naming
// none — a mood, a genre, a language, "more of this" — has nothing a track
// could stand in for, as on the agent path. A name the matcher read out of a
// dedication or a feel, or a weekday, is no ask either (askedNameTest), nor
// is a term that is itself "more of this": a weak matcher copies the request
// whole ("something like this for Sarah"). An ask that points at what is on
// air, read by the matcher as naming nothing but that track (its title alone,
// or no name at all beside the copy), names its credit, as `onAir` does on the
// agent path; one naming someone else ("keep it going with some Michael
// Jackson") asked for them, and the on-air artist stands in for it — the case
// where a declining line outranks that excusal on the agent path.
//
// Curried, because the draw asks it of every candidate by a recent artist,
// and a pool of nothing but those is read whole: the names, the request's
// unasked slots and the on-air reading are built once, then each track costs
// only the excusal.
export function matchedRequestStandIn(
  named: Iterable<string | null | undefined>,
  ctx: Pick<ClaimContext, 'requestText' | 'lookups' | 'onAir'>,
): (track: ClaimTrack | null | undefined) => boolean {
  const names = [...named];
  const asksName = askedNameTest(ctx.requestText);
  const asks = names.filter((n) => asksName(n) && !pointsAtOnAir(n));
  const onAir = ctx.onAir;
  const onAirAsked = !!onAir && pointsAtOnAir(ctx.requestText) && asks.every((n) => asksForTrack(n, onAir));
  const excusing = [ctx.requestText, ...names, ...(ctx.lookups ?? []), onAirAsked ? onAir?.artist : null];
  return (track) => asks.length > 0 && !excusing.some((a) => asksForTrack(a, track));
}

// Is a name from the listener's words, as a line or the matcher spells it, an
// ask? Not a weekday or a run of connectives, nor a word the request uses for
// something other than music. The request's unasked slots are read once per
// test built: once per call of requestStandIn, once per request for the
// cascade's curried reading.
function askedNameTest(requestText: string | null | undefined): (name: string | null | undefined) => boolean {
  const unasked = unaskedSlots(requestText);
  return (name) => {
    const keys = keysOf(name);
    return !keys.every((k) => DAYS.has(k) || MINOR.has(k)) && !unasked.some((slot) => contains(slot, keys));
  };
}

// An ask that points at what is playing (#1979): "more of this", "more like
// that", "another one like this", "same again", "more of the same", "keep it
// going". It names the on-air track as surely as its title would, and a
// "more of this" answer is by the on-air artist, so it is always inside the
// spacing window: read only by its lines, any capitalised word of the
// listener's read back — "Greetings back to Leeds!", "Up the Arsenal!" —
// spaced it. ENGLISH ONLY and as short as DECLINES, for the same reason. Not
// "no more of this", which points away; and before a capital "this"/"that"
// is a determiner ("more of that Prince stuff"), so the name after it is the
// ask and the line reading stands.
const DEICTIC = /(?<!\b(?:no|not|any)\s+)\b(?:more\s+(?:of\s+|like\s+)?(?:this|that|these|those)|(?:another(?:\s+one)?|one\s+more|something|anything)\s+like\s+(?:this|that|these|those)|more\s+of\s+the\s+same|same\s+again|keep\s+(?:it|this|them|em|['’]em|the\s+vibes?)\s+(?:going|coming|rolling))\b/giu;
const DEMONSTRATIVE_END = /(?:this|that|these|those)$/iu;

function pointsAtOnAir(requestText: string | null | undefined): boolean {
  const text = normalizeListenerText(requestText);
  for (const m of text.matchAll(DEICTIC)) {
    const next = /^\s+([\p{L}\p{N}]+)/u.exec(text.slice((m.index ?? 0) + m[0].length))?.[1] ?? '';
    // A lone "I" is no name: "more of this I love it".
    if (DEMONSTRATIVE_END.test(m[0]) && next.length > 1 && /^\p{Lu}/u.test(next)) continue;
    return true;
  }
  return false;
}

// Where a request's words name no music (#1979, read for stand-ins only): who
// it is for, and the feel it asks for. "More of this for Sarah" answered
// "This one's for Sarah!" says the listener's capitalised word over a track
// the line does not name — the #1918 lie's shape — yet nothing was asked for
// that a track could stand in for. Each row is a cue and where its slot sits:
// after the cue, from it (the cue word included), or before it. A slot runs to
// the clause's end, a SLOT_STOP word or SLOT_WORDS words. ENGLISH ONLY and as
// short as DECLINES, for the same reason. A miss reads the word as an ask, and
// the request costs a call and moves; a slot that swallows a real ask ("some
// Prince vibes") leaves it exempt, where it started.
const UNASKED: Array<[RegExp, 'after' | 'from' | 'before']> = [
  // "for Sarah", "for my friend Sarah Jones" — not the ask's own "for" after a
  // verb that cannot introduce a person: "looking for Prince", "in the mood
  // for Prince" name what they want, and the incident's stand-in is spaced
  // under them. "Asking for" and "a request for" name a person as often as an
  // artist ("a request for my wife Sarah"), so their slot stays a dedication.
  [/(?<!\b(?:look(?:s|ed|ing)?|hop(?:e|es|ed|ing)|in\s+(?:the|a)\s+mood|crav(?:e|es|ed|ing))\s+)\bfor\s+/giu, 'after'],
  // "dedicate this to Priya", "shout out to the night shift", "goes out to Jen"
  [/\b(?:dedicat\w*|shout[\s-]?outs?|goes out|going out)\b[^,.;:!?\n]*?\bto\s+/giu, 'after'],
  // "happy birthday Sarah", "happy Friday!" — the greeting whole
  [/\bhappy\s+/giu, 'from'],
  // "it's Sarah's birthday"
  [/['’]s\s+b(?:irth)?day\b/giu, 'before'],
  // "some Friday vibes", "a Sunday morning mood"
  [/\s+(?:vibes?|mood|feels)\b/giu, 'before'],
];
const SLOT_WORDS = 4;
const SLOT_STOP = new Set([
  'please', 'pls', 'plz', 'play', 'by', 'from', 'off', 'but', 'or', 'with',
  'some', 'something', 'anything', 'any', 'more', 'for', 'to',
]);
const CLAUSE_BREAK = /[,.;:!?…\n—–()]/u;
// A day of the week names no music on its own ("it's Friday!").
const DAYS = new Set(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'weekend']);

function unaskedSlots(requestText: string | null | undefined): string[][] {
  const text = normalizeListenerText(requestText);
  const toks = tokenize(text);
  const slots: string[][] = [];
  for (const [cue, side] of UNASKED) {
    for (const m of text.matchAll(cue)) {
      const at = m.index ?? 0;
      const slot: string[] = [];
      if (side === 'before') {
        let edge = at;
        for (let i = toks.length - 1; i >= 0 && slot.length < SLOT_WORDS; i--) {
          const t = toks[i]!;
          if (t.end > at) continue;
          if (SLOT_STOP.has(t.key) || CLAUSE_BREAK.test(text.slice(t.end, edge))) break;
          slot.unshift(t.key);
          edge = t.start;
        }
      } else {
        let edge = side === 'after' ? at + m[0].length : at;
        for (const t of toks) {
          if (t.start < edge) continue;
          if (slot.length >= SLOT_WORDS || SLOT_STOP.has(t.key) || CLAUSE_BREAK.test(text.slice(edge, t.start))) break;
          slot.push(t.key);
          edge = t.end;
        }
      }
      if (slot.length) slots.push(slot);
    }
  }
  return slots;
}

// A word as a listener might misspell it: one edit away (two from eight
// letters) — a letter added, dropped, changed or a neighbouring pair swapped
// ("Madona", "Micheal", "Beyonse"). Under four letters only an exact match
// counts: a short word one letter off is just another word.
function spelledLike(a: string, b: string): boolean {
  if (a === b) return true;
  const shorter = Math.min(a.length, b.length);
  if (shorter < 4) return false;
  const max = shorter >= 8 ? 2 : 1;
  if (Math.abs(a.length - b.length) > max) return false;
  let before: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      let d = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, before[j - 2]! + 1);
      row.push(d);
    }
    before = prev;
    prev = row;
  }
  return prev[b.length]! <= max;
}

// A request word naming this one: the same word, or a misspelling of it. A
// filler word is never read as a misspelling ("play" is not the title "Plays").
const saysWord = (said: string, word: string) => said === word || (!FILLER.has(said) && spelledLike(said, word));

function containsSaid(req: string[], phrase: string[]): boolean {
  if (!phrase.length || phrase.length > req.length) return false;
  for (let i = 0; i + phrase.length <= req.length; i++) {
    if (phrase.every((k, j) => saysWord(req[i + j]!, k))) return true;
  }
  return false;
}

// What a credit is abbreviated to: the first letter of every word, and of every
// word that is not a connective ("Earth, Wind & Fire" is EWF).
function initialsOf(phrase: string[]): string[] {
  const first = (ks: string[]) => ks.map((k) => [...k][0]).join('');
  return [first(phrase), first(phrase.filter((k) => !MINOR.has(k)))].filter((s) => s.length >= 2);
}

// Every run of two or more words of a credit, written as one: how a listener
// spells a split name they have only heard ("Moosewala", "Fleetwoodmac"). Six
// letters at least, so a join never matches a short word by chance.
function joinedRuns(phrase: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < phrase.length; i++) {
    for (let j = i + 2; j <= phrase.length; j++) out.push(phrase.slice(i, j).join(''));
  }
  return out.filter((w) => w.length >= 6);
}

// The request's possible abbreviations: a short word ("MJ", "RHCP") or a run of
// single letters ("M.J.", "R E M").
function abbreviationsOf(req: string[]): Set<string> {
  const out = new Set<string>();
  let letters = '';
  for (const k of [...req, '']) {
    if (k.length === 1 && /\p{L}/u.test(k)) {
      letters += k;
      continue;
    }
    if (letters.length >= 2) out.add(letters);
    letters = '';
    if (k.length >= 2 && k.length <= 6 && !FILLER.has(k)) out.add(k);
  }
  return out;
}

// Do the listener's words name this track — a title form, the album, any
// credited act, one word of the credit ("some Elvis" for Elvis Presley), the
// credit written as one word ("more Moosewala" for Sidhu Moose Wala), the
// credit's initials ("more MJ") — spelled right or a letter off ("Madona")?
// Case-blind, because a listener's casing is no evidence ("madonna or michael
// jackson"). A lone request word is not a title: "something by Michael
// Jackson" does not ask for the Beatles' "Something". It errs wide on
// purpose: a word shared by chance only leaves a request exempt from spacing,
// which is where it started, while a miss steers a genuine ask away from its
// artist. A nickname no spelling rule can reach ("the King") is the run's own
// lookups' to excuse (requestStandIn).
export function asksForTrack(requestText: string | null | undefined, track: ClaimTrack | null | undefined): boolean {
  const req = keysOf(requestText);
  if (!req.length || !track) return false;
  const credit = artistPhrases(track.artist);
  const phrases = [...titlePhrases(track.title), ...credit, ...titlePhrases(track.album)];
  if (phrases.some((p) => !(p.length === 1 && FILLER.has(p[0]!)) && containsSaid(req, p))) return true;
  if (credit.some((p) => p.some((k) => k.length >= 3 && !FILLER.has(k) && req.some((w) => saysWord(w, k))))) return true;
  if (credit.some((p) => joinedRuns(p).some((j) => req.some((w) => saysWord(w, j))))) return true;
  const abbreviations = abbreviationsOf(req);
  return credit.some((p) => p.length > 1 && initialsOf(p).some((i) => abbreviations.has(i)));
}

// Fixed copy for a request whose own lines could not be trusted: names the
// queued track from library metadata and nothing the listener wrote except
// their screened name.
function trackLabel(track: ClaimTrack): string {
  const title = String(track?.title ?? '').trim();
  const artist = String(track?.artist ?? '').trim();
  return artist ? `${title} by ${artist}` : title;
}

// The intro is SPOKEN, and it is composed English, so it follows announceLine's
// gate: '' — the caller's signal to have the model write it — for a persona
// that speaks something else or a name an English voice would read as nothing.
// The ack below is read, not aired, like screenAck's own fixed fallback.
export function plainRequestIntro(track: ClaimTrack, requester: string | null | undefined, persona?: unknown): string {
  if (!composedEnglishFits(persona, track?.title, track?.artist)) return '';
  return isNamedRequester(requester) && composedEnglishFits(persona, requester)
    ? `Here's ${trackLabel(track)}, for ${String(requester).trim()}.`
    : `Here's ${trackLabel(track)}.`;
}

export function plainRequestAck(track: ClaimTrack, requester: string | null | undefined): string {
  return isNamedRequester(requester)
    ? `Coming up for you, ${String(requester).trim()}: ${trackLabel(track)}.`
    : `Coming up for you: ${trackLabel(track)}.`;
}
