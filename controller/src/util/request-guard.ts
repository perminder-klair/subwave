// On-air safety policy for listener requests (raid of 2026-07-28). Pure and
// side-effect-free — the policy chokepoint for routes/request.ts and
// broadcast/dj-agent.ts, pinned by scripts/request-guard.test.ts. The echo
// guard is the load-bearing layer: it is language-agnostic and catches any
// "read this on air" phrasing the opener regexes miss.
import { REQUEST_NAME_MAX } from '../schemas/request.js';

// "Read this verbatim" directive family. The payload always trails the
// directive, so cutting at the earliest match keeps the musical intent
// ("Play something Lo-Fi.") and drops the script. en + ru cover the observed
// raid; extend the list, never inline new patterns at call sites.
//
// The `(?=…)` tail on the first pattern is load-bearing, not decoration: the
// directive nouns are ordinary words, so "open the message BOARD and play some
// jazz" matched and silently truncated a real request to "Please". Requiring
// what follows to look like the start of a payload ("… as follows", "… with
// 'X'", "…: X") keeps every observed raid phrasing and drops the mid-sentence
// collisions. The residue guard below is the backstop for the ones a lookahead
// can't express (notably the two ru patterns).
const OPENER_DIRECTIVES: RegExp[] = [
  /\b(?:start|begin|open)\s+(?:your|the)\s+(?:message|answer|reply|response)\b(?=\s*(?:with|as|by|using|like|[:,]|["“'‘«]))/i,
  /\b(answer|respond|reply|write)(\s+\S+){0,3}\s+as\s+follows\b/i,
  /\bonly\s+(write|say|output)\s+the\s+following\b/i,
  /\bdo\s+not\s+(answer|respond\s+to|mention)\s+this\s+(message|part|prompt)\b/i,
  /начн[иё]\s+(сво[йеё]\s+)?(ответ|сообщение)(?!\w)/iu,
  /ответь?\s+следующим\s+образом(?!\w)/iu,
];

// Below this many words, whatever survived the cut is not a request — it's the
// tail of a false positive ("Please") or a message that was nothing BUT script.
// Either way it must not go on to the matcher: resolving "Please" against the
// library airs an arbitrary track nobody asked for. Returning '' routes it to
// the route's 400, which is the honest answer — we could not read a request out
// of it. Two words clears every real short request we see ("Добавь рэгги",
// "surprise me", "sunny afternoon").
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

// Word-level normalization shared by the echo checks — lowercase, punctuation
// stripped, unicode-safe. Elongated troll tokens ("HEEEELP") survive as-is,
// which makes matches on them trivially strong.
function words(s: string | null | undefined): string[] {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

// True when `script` reads the request back: a common CONTIGUOUS run of
// >= minRun words. Verbatim quotation is the whole signal — an injected script
// is reproduced, not paraphrased.
//
// There used to be a second measure here: an in-order longest-common-
// SUBSEQUENCE ratio, on the theory that it would catch a reordered echo the
// contiguous run misses. It was removed because it does not separate. Measured
// against the raid fixtures and a corpus of natural intros/acks:
//
//   case                        run   lcs-ratio
//   raid: "Get Crank"      TRUE  15        0.58
//   reordered echo         TRUE  10        0.59
//   "like the track now"   FALSE  5        0.86   <- highest ratio of the set
//   "slow sad song"        FALSE  8        0.67
//
// The ratio ranked two ordinary paraphrases ABOVE both real attacks, so no
// threshold exists that admits the attacks and rejects the paraphrases —
// filtering stopwords or short words doesn't move it either. In production it
// meant a listener writing more than ~10 words got a canned ack and a
// regenerated (request-blind) intro almost every time. The contiguous run
// separates cleanly on the same corpus (true: 10/15/26, false: 5-8).
//
// What this gives up, stated plainly: an echo the model genuinely shuffles
// below minRun words of contiguity now passes. That path is covered downstream
// rather than here — the prompts forbid readback on both agent paths
// (LISTENER_TEXT_CLAUSE), and dropEchoedLink re-checks the pick path.
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

// The screen-name cap — an alias of the shared schema's figure, which the
// route boundary and the player's request boxes both enforce as a refusal.
// The slice below stays as this module's belt: cleanRequesterName is a repair
// path by design ('anon', not a 400), and callers that never crossed the
// route boundary still get a bounded name.
const NAME_MAX = REQUEST_NAME_MAX;

// The stand-in cleanRequesterName returns when there is no usable name. It is a
// LEDGER value, not a name: the request log, the webhook payload and the admin
// row all want a non-empty string, so this stays what it has always been. What
// it must never be is a name a prompt hands to a model — `'anon'` is truthy, so
// every anonymous request used to push a literal `Requested by: anon` line plus
// the screening clause below it, inviting the DJ to read a fake name on air.
// Prompt sites gate on isNamedRequester(), never on the bare string (#1347).
export const ANON_REQUESTER = 'anon';

/**
 * Did this request arrive with a real screen name? The one answer to "may a
 * prompt name this listener" — never compare against ANON_REQUESTER inline, or
 * the next prompt site added will forget to.
 */
export function isNamedRequester(name: string | null | undefined): boolean {
  const v = String(name ?? '').trim();
  return v !== '' && v !== ANON_REQUESTER;
}

/**
 * The "nothing matched" decline, addressed to the listener when they signed and
 * left impersonal when they didn't. Here rather than at the two route call
 * sites because it is the same isNamedRequester question, and the version it
 * replaces read "Sorry anon, nothing in the crates matched that." on air.
 */
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

// Echo-guard a spoken intro. `regenerate` must produce a script WITHOUT the
// request text in its prompt — it physically cannot echo what it never saw,
// so one retry suffices; if it somehow still echoes (or throws), drop the
// intro entirely (the track still airs, just unannounced).
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

// Acks get a LOOSER threshold than intros (10 vs 8), which is the opposite of
// what it was — worth spelling out, because "shorter line, tighter guard" is
// the intuitive answer and it was wrong on both halves.
//
// An ack's job is to restate the ask ("Old school hip hop from the nineties, on
// the way") — quoting a few words is the line working, not failing. And unlike
// an intro it never airs: `introScript` is the only field that reaches
// tts.speak; the ack is the HTTP receipt the requester reads back on their own
// screen, plus a session turn. So the blast radius of a missed echo is the
// session window, which dropEchoedLink already re-checks on the way to air.
// At 6 the guard replaced a correct ack with the canned fallback for most
// requests over ~10 words. At 10 a real injected readback (>= 10 contiguous
// words, which every raid sample cleared by a wide margin) still trips it.
//
// A failing ack is replaced, not regenerated — it's one line, the fallback
// reads fine, and it saves a model call under raid load.
const ACK_MIN_RUN = 10;
//
// Reports the verdict so call sites get guardIntro's treatment: log the swap
// and flag it on the durable request record. Silent replacement left the
// operator with no signal at all under conversational trolling — the ack is
// the one line that always reaches the listener, so a run of replacements is
// exactly the shape of an attack in progress.
//
// An EMPTY ack is not a replacement: the model wrote nothing, so the fallback
// is filling a hole rather than covering an echo. Only a real echo flags.
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

// Plain-string form of screenAck. Prefer `screenAck` — every production call
// site uses it, because a replacement the operator can't see is how the raid
// stayed invisible for five hours. This exists for callers that genuinely have
// nowhere to report a verdict, and to keep the pinned contract in
// scripts/request-guard.test.ts intact.
export function guardAck(ack: string | null | undefined, requestText: string, fallback: string): string {
  return screenAck(ack, requestText, fallback).ack;
}

// Pick-path echo guard. The picker agent reads the live session window, which
// carries listener request text verbatim for up to ~40 turns / 4h, so an
// injected phrasing that slipped past the opener regexes can resurface in a
// LATER pick's spoken link — a path neither guardIntro nor screenAck sees
// (they only run on the request that carried the text). Same thresholds as
// guardIntro; `recent` is the request log's newest-first ring, so only the
// last `lookback` texts are checked — an echo of something asked hours ago
// isn't the attack this defends against, and the scan is O(script x text).
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

// Will the mixer eat this pick whole? (#1594)
//
// `cross(duration=d)` buffers d seconds of the OUTGOING track before it can
// hand over, so a source item whose entire playable span is under d is consumed
// by that buffer and never reaches the output. It leaves dj_queue without
// airing and without an error: proto_subhttp already stamped it `ready` — that
// verdict is a curl result at RESOLUTION time, minutes before the seam — so
// queue.verifyPushResolved sees a healthy handoff and the outcome channel has
// nothing to report. The tagged duration measured against the configured
// crossfade at request time is the only honest signal the controller has.
//
// Pure, and it stays pure: `playableSec` comes from music/silence-trim.ts (the
// span AFTER the trim, because a trimmed head or tail is precisely what the
// buffer eats) and `crossfadeSec` from settings.crossfadeDuration. Here rather
// than at the call site because both request paths reach the same question —
// routes/request.ts' three resolutions and broadcast/dj-agent.ts' agent path —
// and a second copy of it is the bug.
//
// Both unknowns answer FALSE, which is the only safe direction: this decides
// whether to warn the operator that a request will not be heard, and a warning
// fired on a missing duration is a warning nobody can act on. Two more
// deliberate falses:
//
//  - A crossfade of 0 (the setting's own floor) is no buffer at all, so nothing
//    is eaten however short the track.
//  - EQUAL is not swallowed. A span of exactly d is entirely crossfade
//    material, which is not the same claim as silence, and the measured failure
//    (#1591, an 18s crossfade against a 15s stinger) is strictly under. Claiming
//    the boundary case would be guessing about the one track we never measured.
//
// It says nothing about whether the track SHOULD air. Requests are exempt from
// maxTrackSeconds and from picker.minTrackLengthSeconds on purpose — an explicit
// ask is not a pick — and this predicate leaves that exactly as it was.
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

// One-pending-per-IP hold (routes/request.ts POST /request): an IP's previous
// request must resolve AND its pick must have fully left `queuedIds` (current
// + upcoming — i.e. aired to completion) before a new one from that IP is
// accepted. Pulled out as a pure predicate rather than inlined at the call
// site so the invariant — spread across every `resolved()` closure that sets
// `entry.pick` — has one place that's actually pinned by a test, instead of a
// future resolution path silently forgetting to set `pick` and defeating the
// hold with nothing catching it.
export function stillInFlight(
  prev: { status?: string; refused?: boolean; pick?: { id?: string } } | null | undefined,
  queuedIds: Set<string>,
): boolean {
  if (!prev) return false;
  if (prev.status === 'pending') return true;
  // A REFUSED resolution (repeat cooldown, already-queued dedup) still records
  // the track it declined on `pick`, so the operator log names it — but
  // nothing was queued on this listener's behalf. Holding their next request
  // until that track leaves the queue would lock them out over a play they
  // never got: "that one just spun" followed by minutes of silence.
  if (prev.refused) return false;
  if (prev.status === 'resolved' && prev.pick?.id) return queuedIds.has(prev.pick.id);
  return false;
}
