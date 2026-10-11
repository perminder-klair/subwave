// Pure on-air safety policy for listener requests: the one chokepoint for
// routes/request.ts and broadcast/dj-agent.ts. Never inline a copy of these
// checks at a call site.
import { REQUEST_NAME_MAX } from '../schemas/request.js';

// The ONE normaliser for listener text, run before every check below and before
// the text is stored. NFKC folds full-width and compatibility forms onto their
// plain letters; then every format character (\p{Cf}: zero-width space/joiners,
// word joiner, soft hyphen, BOM, bidi controls) is DELETED, not replaced with a
// space. Those characters are invisible on screen and silent in TTS, so leaving
// them in lets "start\u200b your answer" slip past the opener patterns and lets a
// payload salted inside each word split into fragments the echo match never
// lines up. Combining marks are kept: Devanagari, Thai and friends need them.
export function normalizeListenerText(raw: string | null | undefined): string {
  return String(raw ?? '').normalize('NFKC').replace(/\p{Cf}/gu, '');
}

// Strip prompt-injection markup from listener text before it is stored, logged,
// displayed or fed to the LLM. A belt over the prompt framing, not the only layer.
// NFKC can expand text; the shared request schema caps both forms before this runs.
export function sanitizeRequestText(raw: string | null | undefined): string {
  return normalizeListenerText(raw)
    // chat/template role + instruction tokens
    .replace(/\[\/?INST\]|<<\/?SYS>>|<\|[^|>]*\|>/gi, ' ')
    // any HTML/XML-ish tag
    .replace(/<\/?[a-z][^>]*>/gi, ' ')
    // leading role markers that fake a new turn
    .replace(/^[ \t]*(system|assistant|developer)\s*:/gim, ' ')
    // the "ignore the previous instructions" family
    .replace(/\b(ignore|disregard|forget|override)\b[^.!?\n]*\b(previous|prior|above|earlier|all)\b[^.!?\n]*\binstructions?\b/gi, ' ')
    // double quotes would break out of the "${text}" framing
    .replace(/"/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// "Read this verbatim" directive family; the payload always trails the
// directive, so the earliest match is the cut point. The `(?=…)` tail on the
// first pattern is required: its nouns are ordinary words, so without it
// "open the message board and play some jazz" truncates a real request.
const OPENER_DIRECTIVES: RegExp[] = [
  /\b(?:start|begin|open)\s+(?:your|the)\s+(?:message|answer|reply|response)\b(?=\s*(?:with|as|by|using|like|[:,]|["“'‘«]))/i,
  /\b(answer|respond|reply|write)(\s+\S+){0,3}\s+as\s+follows\b/i,
  /\bonly\s+(write|say|output)\s+the\s+following\b/i,
  /\bdo\s+not\s+(answer|respond\s+to|mention)\s+this\s+(message|part|prompt)\b/i,
  /начн[иё]\s+(сво[йеё]\s+)?(ответ|сообщение)(?!\w)/iu,
  /ответь?\s+следующим\s+образом(?!\w)/iu,
];

// Below this many surviving words the remainder is not a request; returning ''
// routes it to the route's 400 rather than letting the matcher air an arbitrary
// track. Two words clears every real short request.
const MIN_KEPT_WORDS = 2;

export function stripScriptedOpener(raw: string): { text: string; injection: string | null } {
  const text = normalizeListenerText(raw);
  let cut = -1;
  for (const re of OPENER_DIRECTIVES) {
    const m = re.exec(text);
    if (m && (cut === -1 || m.index < cut)) cut = m.index;
  }
  if (cut === -1) return { text, injection: null };
  // Trim a dangling connective the cut can leave behind ("... и", "... and").
  const kept = text.slice(0, cut).replace(/[\s,;:—-]+(and|и)?\s*$/iu, '').trim();
  if (words(kept).length < MIN_KEPT_WORDS) return { text: '', injection: 'scripted-opener' };
  return { text: kept, injection: 'scripted-opener' };
}

// Lowercase, punctuation-stripped, unicode-safe tokens shared by the echo checks.
// Both sides go through the same normaliser, and combining marks are deleted
// rather than turned into spaces, so a word only splits where it visibly does.
function words(s: string | null | undefined): string[] {
  return normalizeListenerText(s)
    .toLowerCase()
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

// True when `script` reads the request back: a common CONTIGUOUS run of
// >= minRun words. Contiguity is the only measure that separates real echoes
// from paraphrase; a subsequence ratio ranked ordinary acks above real attacks.
// A shuffled echo below minRun passes here and is caught downstream (prompt
// clauses + dropEchoedLink).
export function echoesRequest(
  script: string | null | undefined,
  requestText: string | null | undefined,
  { minRun = 8 }: { minRun?: number } = {},
): boolean {
  const a = words(script);
  const b = words(requestText);
  if (!a.length || !b.length) return false;

  // Longest common contiguous run, one rolling DP row.
  let best = 0;
  let dp = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const next = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        next[j] = dp[j - 1] + 1;
        if (next[j] > best) best = next[j];
      }
    }
    dp = next;
  }
  return best >= minRun;
}

// Common-script allow-list: kills hieroglyph/cuneiform/emoji floods while
// keeping every ordinary name (Latin, Cyrillic, Arabic, Indic, CJK, ...).
const NAME_DISALLOWED = /[^\p{sc=Latin}\p{sc=Cyrillic}\p{sc=Greek}\p{sc=Arabic}\p{sc=Hebrew}\p{sc=Devanagari}\p{sc=Gurmukhi}\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}\p{sc=Thai}\p{Nd}\s\-_.']/gu;

// Alias of the shared schema's cap; the slice below still bounds callers that
// never crossed the route boundary, since cleanRequesterName repairs, not 400s.
const NAME_MAX = REQUEST_NAME_MAX;

// Ledger stand-in for "no usable name" — never hand it to a prompt as a name;
// prompt sites gate on isNamedRequester(), never on the bare string (#1347).
export const ANON_REQUESTER = 'anon';

/** The one answer to "may a prompt name this listener"; never compare against
 * ANON_REQUESTER inline. */
export function isNamedRequester(name: string | null | undefined): boolean {
  const v = String(name ?? '').trim();
  return v !== '' && v !== ANON_REQUESTER;
}

/** The "nothing matched" decline, named only when the listener really signed. */
export function sorryNoMatch(requester: string | null | undefined): string {
  return isNamedRequester(requester)
    ? `Sorry ${String(requester).trim()}, nothing in the crates matched that.`
    : 'Sorry, nothing in the crates matched that.';
}

// Latin look-alikes from the two other scripts the name allow-list admits. Only
// used to compare a name against the reserved list, never to rewrite what a
// listener typed, so an ordinary Cyrillic or Greek name is left as written.
const CONFUSABLES: Record<string, string> = {
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c',
  т: 't', у: 'y', х: 'x', і: 'i', ї: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ӏ: 'l', ɡ: 'g',
  α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'i', κ: 'k', μ: 'u', ν: 'v', ο: 'o', ρ: 'p',
  τ: 't', υ: 'u', χ: 'x', ω: 'w', ϲ: 'c',
};

// Comparison key for the reserved-name screen: normalised, case-folded,
// look-alikes folded, and split into words on anything that is not a letter or
// digit, so "Wren.", "Ｗｒｅｎ" and "Wrеn" (Cyrillic е) all key the same as
// "Wren".
function nameWords(s: string | null | undefined): string[] {
  return normalizeListenerText(s)
    .toLowerCase()
    .replace(/\p{M}/gu, '')
    .replace(/./gsu, (ch) => CONFUSABLES[ch] ?? ch)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

// True when the name IS a reserved name or carries one as a run of whole words
// ("DJ Wren", "Admin_", "night owl fan" against a persona "Night Owl"). Whole
// words only, so a name that merely contains the letters ("Madjid" vs "dj",
// "Ghost" vs "host") is never caught.
function impersonatesReserved(name: string, reserved: string[]): boolean {
  const nw = nameWords(name);
  if (!nw.length) return false;
  for (const r of reserved) {
    const key = nameWords(r).join('');
    if (key.length < 2) continue;
    for (let i = 0; i < nw.length; i++) {
      let run = '';
      for (let j = i; j < nw.length && run.length < key.length; j++) {
        run += nw[j];
        if (run === key) return true;
      }
    }
  }
  return false;
}

export function cleanRequesterName(raw: string | null | undefined, reserved: string[] = []): string {
  const cleaned = normalizeListenerText(raw)
    .replace(NAME_DISALLOWED, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX)
    .trim();
  if (!cleaned) return ANON_REQUESTER;
  if (impersonatesReserved(cleaned, reserved)) return ANON_REQUESTER;
  return cleaned;
}

// The artist a listener asked for that the library does not have, in the form
// an intro may name on air ("no Katy Perry in the crates"). It is the matcher's
// reading of the listener's own words, so it is listener text: normalised,
// reduced to the characters artist names actually use, and refused outright
// (null) when it is too long to be a name or carries a scripted opener. A
// refused name is dropped, never truncated, so the intro owns the miss without
// naming anyone rather than reading out half a sentence. The prompt still
// frames whatever survives as data with a judgment clause; this is the half a
// rule can decide.
const MISSED_ARTIST_MAX_CHARS = 60;
const MISSED_ARTIST_MAX_WORDS = 8;
const MISSED_ARTIST_DISALLOWED = /[^\p{L}\p{M}\p{N}\s.,'’&+!?\-/$()*#@~_]/gu;

export function cleanMissedArtist(raw: string | null | undefined): string | null {
  const cleaned = normalizeListenerText(raw)
    .replace(MISSED_ARTIST_DISALLOWED, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  if (cleaned.length > MISSED_ARTIST_MAX_CHARS) return null;
  if (cleaned.split(' ').length > MISSED_ARTIST_MAX_WORDS) return null;
  if (stripScriptedOpener(cleaned).injection) return null;
  return cleaned;
}

// Every request text a line must not read back: the request being answered plus
// any other listener text the model could see. An empty entry is skipped.
type RequestTexts = string | ReadonlyArray<string | null | undefined>;

function echoesAny(script: string | null | undefined, texts: RequestTexts, minRun?: number): boolean {
  const list = typeof texts === 'string' ? [texts] : texts;
  return list.some((t) => !!t && echoesRequest(script, t, minRun ? { minRun } : {}));
}

// Echo-guard a spoken intro. `regenerate` must build its script WITHOUT the
// request text in the prompt, so one retry suffices; a still-echoing or throwing
// retry drops the intro (the track still airs). `requestText` may also carry the
// other request texts in the model's window, so a line that reads out a
// DIFFERENT listener's request is caught too.
export async function guardIntro(
  script: string | null,
  requestText: RequestTexts,
  regenerate: () => Promise<string | null>,
): Promise<{ script: string | null; guard: string | null }> {
  if (!script || !echoesAny(script, requestText)) return { script, guard: null };
  let clean: string | null = null;
  try { clean = await regenerate(); } catch { clean = null; }
  if (clean && !echoesAny(clean, requestText)) return { script: clean, guard: 'echo-regenerated' };
  return { script: null, guard: 'echo-dropped' };
}

// Acks get a LOOSER threshold than intros (10 vs 8) on purpose: an ack's job is
// to restate the ask, and it never airs (only introScript reaches tts.speak).
const ACK_MIN_RUN = 10;

// Replaces rather than regenerates, and reports the verdict so a run of
// replacements is visible to the operator. An EMPTY ack is a hole being filled,
// not an echo, so it does not flag.
export function screenAck(
  ack: string | null | undefined,
  requestText: RequestTexts,
  fallback: string,
): { ack: string; guard: string | null } {
  const a = String(ack ?? '').trim();
  if (!a) return { ack: fallback, guard: null };
  if (!echoesAny(a, requestText, ACK_MIN_RUN)) return { ack: a, guard: null };
  return { ack: fallback, guard: 'ack-replaced' };
}

// Pick-path echo guard: the session window carries request text verbatim, so an
// injected phrasing can resurface in a LATER pick's link, which neither
// guardIntro nor screenAck sees. `windowTexts` must be every request text still
// in the window the agent read (session.windowRequestTexts()), pending requests
// included: a guard whose horizon is shorter than the window lets a request age
// out of the check while the model can still quote it.
export function echoesRecentRequest(
  script: string | null | undefined,
  windowTexts: ReadonlyArray<string | null | undefined> | null | undefined,
): boolean {
  if (!script || !Array.isArray(windowTexts)) return false;
  return echoesAny(script, windowTexts);
}

// Will the mixer eat this pick whole? (#1594) `cross(duration=d)` buffers d
// seconds of the outgoing track, so an item whose whole playable span is under d
// never reaches output and nothing reports it. `playableSec` is the span AFTER
// silence-trim; `crossfadeSec` is settings.crossfadeDuration. Fails FALSE on
// either unknown and on crossfade 0, and EQUAL is not swallowed (strictly under
// is the measured failure). It says nothing about whether the track should air.
export function swallowedByCrossfade(
  playableSec: number | null | undefined,
  crossfadeSec: number | null | undefined,
): boolean {
  const span = Number(playableSec);
  const cross = Number(crossfadeSec);
  if (!Number.isFinite(span) || span <= 0) return false;
  if (!Number.isFinite(cross) || cross <= 0) return false;
  return span < cross;
}

// One-pending-per-IP hold (POST /request): the previous request must resolve AND
// its pick must have left `queuedIds` (current + upcoming) before a new one from
// that IP is accepted. Every resolution path must set `entry.pick` or the hold
// is silently defeated.
export function stillInFlight(
  prev: { status?: string; refused?: boolean; pick?: { id?: string } } | null | undefined,
  queuedIds: Set<string>,
): boolean {
  if (!prev) return false;
  if (prev.status === 'pending') return true;
  // A refused resolution still records the declined track on `pick`, but nothing
  // was queued for this listener, so it must not hold their next request.
  if (prev.refused) return false;
  if (prev.status === 'resolved' && prev.pick?.id) return queuedIds.has(prev.pick.id);
  return false;
}
