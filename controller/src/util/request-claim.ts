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
// substitution ("no Michael Jackson tonight, but here's Madonna"). Pure: the
// orchestration (one corrective re-pick, then plain copy) is the request
// agent's, in broadcast/dj-agent.ts.
//
// Three sources of a wrong name, each chosen because it needs no world
// knowledge (the asked-for artist is often exactly the one the library lacks):
//
//   request          a run of the listener's own words the line repeats, read for
//                    the proper names in it — the incident's "Michael Jackson".
//                    A lowercase word splits a run rather than disqualifying
//                    it, so "some upbeat Michael Jackson" read back still yields
//                    the name. A dodge without naming the track trips it: the
//                    corrected line will then say what is really playing, which
//                    is the point.
//   candidate-*      another candidate's artist or title — the model describing
//                    the neighbour of the id it returned.
//   quoted-title     a quoted, title-cased span — "'Billie Jean'" — which radio
//                    copy only ever uses for a title.
//
// False positives are bounded by what counts as a NAME (see nameLike): the
// listener's name is never a claim ("Got you, Michael"), lowercase words never
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
  // Every OTHER candidate the run surfaced.
  others?: Iterable<ClaimTrack | null | undefined>;
}

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

export function lineClaims(line: string | null | undefined, ctx: ClaimContext): {
  claims: LineClaim[]; titleNamed: boolean; artistNamed: boolean;
} {
  const text = normalizeListenerText(line);
  const toks = tokenize(text);
  const titles = titlePhrases(ctx.track?.title);
  const artists = artistPhrases(ctx.track?.artist);
  const own = [...titles, ...artists, ...titlePhrases(ctx.track?.album)];
  const titleNamed = names(toks, titles);
  const artistNamed = names(toks, artists);
  if (!toks.length) return { claims: [], titleNamed, artistNamed };

  // The queued track's own names, masked out before anything is read as a claim.
  const masked = new Array<boolean>(toks.length).fill(false);
  for (const p of own) {
    for (const i of occurrences(toks, p)) for (let k = 0; k < p.length; k++) masked[i + k] = true;
  }
  const requester = isNamedRequester(ctx.requester) ? keysOf(ctx.requester) : [];
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
    if (requester.length && contains(requester, span.map((t) => t.key))) return;
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

  // 2. Another candidate's artist or title.
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
        if (masked.slice(i, i + p.length).some(Boolean) || !nameLike(span)) continue;
        if (requester.length && contains(requester, p)) continue;
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
    if (requester.length && contains(requester, span.map((t) => t.key))) continue;
    add('quoted-title', span);
  }

  return { claims, titleNamed, artistNamed };
}

// The claims that make a line wrong about the queued track. A wrong ARTIST is
// excused only by naming the queued artist, a wrong TITLE only by naming the
// queued title; the listener's own words, which could be either, by naming
// either. Empty means the line may air.
export function misnamedClaims(line: string | null | undefined, ctx: ClaimContext): LineClaim[] {
  const { claims, titleNamed, artistNamed } = lineClaims(line, ctx);
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
