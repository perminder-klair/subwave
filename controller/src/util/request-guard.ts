// Pure on-air safety policy for listener requests: the one chokepoint for
// routes/request.ts and broadcast/dj-agent.ts. Never inline a copy of these
// checks at a call site.
import { REQUEST_NAME_MAX } from '../schemas/request.js';

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
  const text = String(raw ?? '');
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
function words(s: string | null | undefined): string[] {
  return String(s ?? '')
    .toLowerCase()
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

export function cleanRequesterName(raw: string | null | undefined, reserved: string[] = []): string {
  const cleaned = String(raw ?? '')
    .replace(NAME_DISALLOWED, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX)
    .trim();
  if (!cleaned) return ANON_REQUESTER;
  const lc = cleaned.toLowerCase();
  if (reserved.some((r) => r && String(r).trim().toLowerCase() === lc)) return ANON_REQUESTER;
  return cleaned;
}

// Echo-guard a spoken intro. `regenerate` must build its script WITHOUT the
// request text in the prompt, so one retry suffices; a still-echoing or throwing
// retry drops the intro (the track still airs).
export async function guardIntro(
  script: string | null,
  requestText: string,
  regenerate: () => Promise<string | null>,
): Promise<{ script: string | null; guard: string | null }> {
  if (!script || !echoesRequest(script, requestText)) return { script, guard: null };
  let clean: string | null = null;
  try { clean = await regenerate(); } catch { clean = null; }
  if (clean && !echoesRequest(clean, requestText)) return { script: clean, guard: 'echo-regenerated' };
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
  requestText: string,
  fallback: string,
): { ack: string; guard: string | null } {
  const a = String(ack ?? '').trim();
  if (!a) return { ack: fallback, guard: null };
  if (!echoesRequest(a, requestText, { minRun: ACK_MIN_RUN })) return { ack: a, guard: null };
  return { ack: fallback, guard: 'ack-replaced' };
}

// Plain-string form of screenAck. Prefer `screenAck`: a replacement the operator
// cannot see is invisible under attack.
export function guardAck(ack: string | null | undefined, requestText: string, fallback: string): string {
  return screenAck(ack, requestText, fallback).ack;
}

// Pick-path echo guard: the session window carries request text verbatim, so an
// injected phrasing can resurface in a LATER pick's link, which neither
// guardIntro nor screenAck sees. `recent` is the request log's newest-first
// ring; only the last `lookback` texts are checked.
export function echoesRecentRequest(
  script: string | null | undefined,
  recent: Array<{ text?: string | null }> | null | undefined,
  { lookback = 5 }: { lookback?: number } = {},
): boolean {
  if (!script || !Array.isArray(recent)) return false;
  for (const entry of recent.slice(0, lookback)) {
    const text = entry?.text;
    if (text && echoesRequest(script, text)) return true;
  }
  return false;
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
