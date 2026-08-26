// Side-effect-free queue helpers: the pacing constants, the stale-link guard,
// and the small comparisons the watcher and drain paths share. Nothing here
// touches disk, TTS or the queue's state, which is what makes the guard
// unit-pinnable (scripts/stale-link.test.ts).
//
// Part of the queue/ split - see ../queue.ts, which owns the Queue class.

import * as library from '../../music/library.js';
import * as settings from '../../settings.js';
import { DRAIN_DEADLINE_SEC } from '../drain-policy.js';
import type { Track } from './types.js';

interface TransitionItem {
  track: Track;
  sent?: boolean;
  stemSeam?: boolean;
}

// Human-readable description of the NEXT FINALISED seam the operator will
// hear. applyMixTransition and the pair/stem stamps run only when `incoming`
// drains, so flags on an unsent item are still agent proposals: vetoes may
// remove them and drain-time policy may add another. Returning null keeps the
// admin honest until `sent` makes the pair authoritative. Exit gestures ride
// the outgoing track while entry gestures ride the incoming track, so the
// answer has to inspect both sides. Washout may combine with sweep/blend; stem
// rendering owns the whole seam and therefore overrides every live effect.
export function nextTransitionLabel(
  outgoing: TransitionItem | null | undefined,
  incoming: TransitionItem | null | undefined,
): string | null {
  if (!incoming || incoming.sent !== true) return null;
  if (incoming.stemSeam) return 'Stem blend';

  const labels: string[] = [];
  const washing = outgoing?.track.washout === true;
  const looping = outgoing?.track.loop === true && !washing;

  if (washing) labels.push('Washout');
  else if (looping) labels.push('Loop');

  // Mirrors radio.liq's precedence: loop suppresses every entry effect;
  // washout suppresses dissolve/chop but can coexist with sweep/blend.
  if (!looping && incoming.track.sweep) labels.push('Sweep');
  if (!looping && incoming.track.blend) labels.push('Blend');
  if (!washing && !looping && incoming.track.dissolve) labels.push('Dissolve');
  if (!washing && !looping && incoming.track.chop) labels.push('Chop');

  return labels.length > 0 ? labels.join(' + ') : 'Normal';
}

export function pickLinkInterval() {
  const f = settings.effectiveFrequency();
  if (f === 'silent')     return Infinity;
  if (f === 'quiet')      return 8 + Math.floor(Math.random() * 13);
  if (f === 'chatty')     return 1 + Math.floor(Math.random() * 5);
  if (f === 'aggressive') return 1 + Math.floor(Math.random() * 3);
  if (Math.random() < 0.15) return 10 + Math.floor(Math.random() * 6);
  return 1 + Math.floor(Math.random() * 9);
}

// How many consecutive reconcile checks may report an EMPTY dj_queue (while the
// controller still holds sent items) before we treat those items as genuinely
// gone and clear them. A single empty read is ambiguous — a just-sent pick may
// be mid-poll, or Liquidsoap may have restarted and lost the queue — so we never
// drop on one read. Unlike the old `_autoMisses` heuristic (which advanced on
// benign metadata mismatches while the tracks were still in dj_queue, wrongly
// wiping live queues — #632), this only advances when Liquidsoap AUTHORITATIVELY
// reports no pending requests, so an interleaved jingle or artist-string variance
// can't trip it.
export const EMPTY_DJ_QUEUE_CLEAR_THRESHOLD = 3;

// Upper bound on how far a recordPlay end-stamp can sit after the play's start
// for the events-backfill dedup (playAlreadyRecorded). recordPlay stamps
// endedAt at the track's END; an event's `t` is its START, so the two differ by
// the track length. 15 min comfortably covers normal tracks (a track longer
// than this is rare and only costs one harmless duplicate sidecar row), while
// staying short enough that a genuine replay — always spaced more than a track
// length apart — keeps its own entry rather than being merged away.
export const BACKFILL_DEDUP_MAX_GAP_MS = 15 * 60_000;

// How far PAST the next pick's expected start the show-boundary look-ahead
// probes (see onTrackStarted). The pick's start time alone under-corrects: a
// track starting 30s before a boundary plays almost entirely inside the new
// show but would still resolve the old one. Two minutes ≈ the midpoint of a
// typical track, so whichever show owns most of the pick's airtime wins. The
// symmetric cost — an on-format-for-the-NEXT-show track starting a minute or
// two early — is how real radio tees up a changeover anyway.
export const PICK_SHOW_LOOKAHEAD_SEC = 120;

// The moment the pick — and its attached link — actually starts AIRING:
// `showAt` minus the attribution padding above. `showAt` deliberately probes
// past the start so show identity resolves right (#1205), but a link's spoken
// clock must not inherit that padding: ctx resolved at `showAt` put "Local
// time" exactly two minutes ahead of air on every pick-attached link (#1282,
// a regression from #864's own fix). Exact inverse of runPickCycle's
// `showAt = now + leadSec + PICK_SHOW_LOOKAHEAD_SEC`, kept here beside the
// constant so the two can't drift apart.
export function linkAirDate(showAt: Date): Date {
  return new Date(showAt.getTime() - PICK_SHOW_LOOKAHEAD_SEC * 1000);
}

// How much runway `linkAirDate(showAt)` needs before it is trustworthy enough
// to speak on air (#1314).
//
// That date is a FORECAST, made once at pick-decision time from the on-air
// track's remaining play, and nothing re-checks it afterwards. It only holds if
// the pick reaches Liquidsoap BEFORE that track ends. When the round outruns
// the runway, dj_queue is empty at the seam, auto.m3u fills the slot, and the
// pick airs at the END of that filler track — while its link still names the
// moment the filler STARTED, i.e. a whole track behind. #1282 removed a fixed
// +120s overshoot that had been masking this undershoot on average.
//
// Sized off the pick round itself, measured over 788 rounds: 27.7% ran longer
// than 45s, 18.3% longer than 60s, only 0.3% longer than 120s. The exposed
// population is maybeDeadlinePick's empty-queue backstop, which fires with
// DRAIN_DEADLINE_SEC..HARD_DEADLINE_SEC of runway on ANY station whatever its
// track lengths — so the floor is that same deadline: speak the clock only when
// the pick is made AHEAD of the endgame window, never inside it. Below the floor
// the link states no time, the pre-#864 behaviour for an unknowable air moment.
//
// The flip side is accepted, not accidental: a library whose tracks run under
// ~2 minutes never has this much runway even at track start, so its links never
// speak the clock — every one of its seams sits inside the risk window the floor
// exists to silence, and hourly checks still tell the time.
export const LINK_CLOCK_MIN_RUNWAY_SEC = DRAIN_DEADLINE_SEC;

// The instant a pick-attached link may claim to air at, or null when the
// forecast can't be trusted (no look-ahead at all, or too little runway left).
// Callers pass the LIVE clock, not the moment `showAt` was built: on the pool
// path the link is written after the pick call has already burned part of the
// runway, and that spend is exactly what makes a forecast go bad.
export function linkClockAt(showAt: Date | null | undefined, nowMs: number): Date | null {
  if (!showAt) return null;
  const airAt = linkAirDate(showAt);
  if ((airAt.getTime() - nowMs) / 1000 < LINK_CLOCK_MIN_RUNWAY_SEC) return null;
  return airAt;
}

// How far the real air moment may sit from the time a link was told to speak
// before the line is dropped instead of aired.
//
// The forecast is inherently loose by ~40s: the seam fires at the START of the
// crossfade (4-12s early), a jingle or bed can push it out (5-15s late), and
// every listener hears it a further `stream.bufferSeconds` (22s by default)
// behind the live edge at which it was stamped. 90s clears all of that with
// room to spare while staying far below a missed slot, which costs a whole
// filler track (3-5 min). With LINK_CLOCK_MIN_RUNWAY_SEC in front of it this
// is a backstop for the 0.3% tail, not a routine drop.
export const LINK_CLOCK_DRIFT_TOLERANCE_SEC = 90;

// Should airIntro drop this link because the clock it was written against no
// longer matches reality? Only items that were actually GIVEN a clock carry a
// `linkClockAt` stamp, so a link written under a clock ban is never dropped
// here. Same trade as shouldDropStaleLink: silence on one hand-off beats airing
// a wrong fact, and rendered audio can't be re-cut. Absolute, because a
// predecessor cueing out early moves the seam the other way.
//
// Deliberately NOT narrowed to lines that demonstrably state a time, the way
// shouldDropStaleLink narrows to lines naming their predecessor. That guard can
// afford `mentionsTrack` because it matches exact title/artist strings; a clock
// has no such handle — "18:38", "twenty to seven", or under a spell-out house
// rule "eighteen thirty-eight" — and a detector that misses one airs the wrong
// time, which is the whole failure. So the stamp records the clock being
// OFFERED, not used: a link that was given one and didn't use it can be dropped
// for nothing. Behind LINK_CLOCK_MIN_RUNWAY_SEC that costs a link in the 0.3%
// tail, cheaper than a regex that has to be right about every phrasing.
export function linkClockDrifted(clockAtMs: number | null | undefined, nowMs: number): boolean {
  if (typeof clockAtMs !== 'number' || !Number.isFinite(clockAtMs)) return false;
  return Math.abs(nowMs - clockAtMs) > LINK_CLOCK_DRIFT_TOLERANCE_SEC * 1000;
}

// The other half of the rule above: what an enqueued item's `linkClockAt` may
// be set to. `linkClockDrifted` can only honour "a link written under a clock
// ban is never dropped" if the stamp is withheld at the point the item is
// queued, and BOTH pick paths have to agree about that — they reach the same
// `enqueuePick` from different code with different reasons to withhold.
//
// `clockOffered` is the question, and it is not the same as "we computed an
// air time". `airAt` says the air moment is FORECASTABLE; whether the model
// was actually handed a clock is a second decision on top of it — the agent
// path also needs a clock in its context (`airClock`), and either path can be
// overruled by the station clock switch (broadcast/clock-policy.ts). Stamping
// on `airAt` alone is how a link written under a flat ban still got dropped for
// drifting away from a time it was never allowed to say.
//
// Kept as a named helper rather than a ternary at each call site because the
// two sites are 170 lines apart and the first one to be updated is the one that
// looks correct in isolation — which is exactly how they diverged.
export function linkClockStampFor(
  airAt: Date | null | undefined,
  clockOffered: boolean,
): Date | null {
  return airAt && clockOffered ? airAt : null;
}

// Seconds from NOW until the pick being made will start airing — the lead the
// show look-ahead adds to the wall clock (see runPickCycle).
//
// Measured from the on-air track's REMAINING time, never its full duration. The
// pick cycle doesn't only run at a track start — the pair-drain deadline
// backstop fires it ~2 min from the end, and boot recovery fires it part-way
// through a track. Full duration there overstates the lead by everything already
// elapsed, walking `showAt` across the next schedule boundary while the real
// next track still starts inside the current show: that aired a handoff
// five-plus minutes early, over the middle of a song, with the session flipped
// to a show `/now-playing` still reported as the old one (#1205).
//
//  - `heldSec` null → the pick follows the ON-AIR track: lead = its remaining.
//  - `heldSec` set  → the deadline path, where the pick follows a HELD track
//                     queued behind the on-air one: lead = remaining + held.
//
// Unknown clock (no start stamp, no duration) or a held track of unknown
// length → null, i.e. no look-ahead at all, the pre-look-ahead behaviour.
// Clamped at 0 so a track past its cue-out can't pull `showAt` backwards.
export function pickLeadSec(remainingSec: number | null, heldSec: number | null = null): number | null {
  if (typeof remainingSec !== 'number' || !Number.isFinite(remainingSec)) return null;
  const rem = Math.max(0, remainingSec);
  if (heldSec == null) return rem;
  if (!Number.isFinite(heldSec) || heldSec <= 0) return null;
  return rem + heldSec;
}

// Has this events-log play already been recorded by recordPlay? The old dedup
// keyed on `${endedAt}|${title}` — an EXACT timestamp match — but recordPlay's
// end-stamp never equals the event's start `t`, so it never fired and every
// play got a duplicate id-less copy, filling the 300-entry sidecar in ~5h
// instead of ~12h (halving the real anti-repeat window). Match on title|artist
// with an existing endedAt landing in [t, t + maxGapMs] instead: exactly the
// window a recordPlay end-stamp falls in for the SAME play. Pure + exported so
// the dedup logic is unit-pinned (scripts/recent-plays.test.ts) without disk.
export function playAlreadyRecorded(
  existing: { title: string | null; artist: string | null; endedAt: string }[],
  ev: { title?: string | null; artist?: string | null; t: string },
  maxGapMs: number,
): boolean {
  const keyOf = (title: string | null | undefined, artist: string | null | undefined) =>
    `${(title || '').toLowerCase().trim()}|${(artist || '').toLowerCase().trim()}`;
  const k = keyOf(ev.title, ev.artist);
  const t = new Date(ev.t).getTime();
  if (!Number.isFinite(t)) return false;
  for (const p of existing) {
    if (keyOf(p.title, p.artist) !== k) continue;
    const at = new Date(p.endedAt).getTime();
    if (Number.isFinite(at) && at >= t && at - t <= maxGapMs) return true;
  }
  return false;
}

// Duration ladder shared by the length-cap checks (applyMixTransition's
// auto-washout and the drain loop's stem-blend outCapped gate): the track
// object first (Subsonic picks carry it), the library row when it doesn't
// (agent picks resolve from the picker tools' slim projections, which omit
// length when the source tool didn't surface one). 0 = unknown. The two
// checks MUST agree — a 0 read as "uncapped" in one of them arms a stem
// blend on an ending the cap never lets air (and strips the auto-washout
// protecting the forced cut).
export function knownDurationSec(track: Track): number {
  const dur = Number(track.duration) || 0;
  if (dur) return dur;
  return track.id ? Number(library.get(track.id)?.durationSec) || 0 : 0;
}


export function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

// Do two track refs point at the same song? Used by the stale back-announce
// guard. Prefer the Subsonic id when both carry one (the reliable key); fall
// back to a normalised title match for auto-playlist tracks that reach the
// watcher without an id.
function sameTrack(
  a: { id?: string | null; title?: string | null } | null,
  b: { id?: string | null; title?: string | null } | null,
): boolean {
  if (!a || !b) return false;
  if (a.id && b.id) return a.id === b.id;
  const norm = (s: string | null | undefined) => (s || '').toLowerCase().trim();
  return !!norm(a.title) && norm(a.title) === norm(b.title);
}

// Does this spoken line actually name `track` (by title or artist)? A coarse
// case-insensitive substring test — enough to tell a forward-looking link
// ("here's something new") from one that back-announces a specific track ("that
// was Blue Monday by New Order"). The ≥4-char floor keeps a tiny/common title
// ("OK", "Go", "Up") from matching incidental words in unrelated patter.
function mentionsTrack(
  text: string | null | undefined,
  track: { title?: string | null; artist?: string | null } | null,
): boolean {
  const hay = (text || '').toLowerCase();
  if (!hay || !track) return false;
  const t = (track.title || '').toLowerCase().trim();
  const a = (track.artist || '').toLowerCase().trim();
  return (t.length >= 4 && hay.includes(t)) || (a.length >= 4 && hay.includes(a));
}

// Should airIntro DROP this item's intro/link as a stale back-announce? Links
// are written forward-looking (introduce the pick, never name the just-played
// track), so the common case never trips this. It's a precise safety-net for
// the model disobeying that instruction: fire ONLY when the rendered line names
// a specific predecessor (`linkPrev`) AND that track is NOT what actually played
// just before it — the off-by-one a listener request causes when it slips ahead
// of the pick after the link was rendered. A forward-looking link (doesn't name
// the previous track) always airs, even if a request jumped ahead, so there's no
// silent hand-off. Items with no linkPrev (request intros) always air too. Pure
// + exported so the guard is unit-pinned (scripts/stale-link.test.ts) without
// touching disk or TTS.
export function shouldDropStaleLink(
  item: { linkPrev?: { id?: string | null; title?: string | null; artist?: string | null } | null; introScript?: string | null } | null,
  predecessor: { id?: string | null; title?: string | null } | null,
): boolean {
  if (!item?.linkPrev) return false;
  if (sameTrack(item.linkPrev, predecessor)) return false;   // names the right track → fine
  return mentionsTrack(item.introScript, item.linkPrev);     // wrong predecessor — only drop if it's actually named
}

// Does the track now starting already bring its OWN spoken line to this
// boundary — an auto-DJ link, or a listener request's intro? If so a
// boundary-deferred wall-clock segment (the station ident) must NOT also air
// here: the two are different kinds, so no per-kind cooldown sees the pair, and
// the airVoice serialiser only stops them OVERLAPPING — back to back with no
// music between is precisely what it produces (issue #1258).
//
// `introAired` is deliberately NOT consulted. An item still sitting in
// `upcoming` whose intro has already fired is the BED case: onBedStarted airs
// the link over the instrumental bed seconds before the song itself starts, so
// the ident would land right behind a link the listener just heard — the same
// collision with the order reversed.
//
// The one exception is a link airIntro is about to drop as a stale
// back-announce: that boundary ends up silent after all, so the ident is the
// only thing that would speak and it should. Pure + exported so the rule is
// unit-pinned (scripts/ident-link-collision.test.ts).
//
// The rule mirrors airIntro's own airing decision, and `opts` carries the
// runtime drop paths the item's fields alone can't predict — all of which leave
// the boundary silent, so the ident may take it after all:
//   - `voiceAllowed` — airIntro's station-voice backstop (settings.tts.enabled
//     off) drops the line outright. The pending segment itself may still air:
//     manual /dj/segment triggers are exempt from the voice switch.
//   - `wavExists` — a rendered WAV the voice reaper has already deleted, with
//     no script left on the item to re-render from, is a silent return in
//     airIntro. A surviving script always speaks (airIntro re-renders).
//   - `nowMs` — the live clock, against which a link whose spoken time has
//     drifted past tolerance is dropped (linkClockDrifted, #1314).
// Injected rather than read here so the rule stays pure; omitting them assumes
// voice on, the WAV present, and the clock still good.
export function boundaryCarriesTrackVoice(
  item: {
    introScript?: string | null;
    introWav?: string | null;
    // Part of the contract even though this rule never reads them: introAired
    // is deliberately ignored (the BED case above), and introKind doesn't
    // matter — links and request intros are both track-tied and unmovable.
    introKind?: string | null;
    introAired?: boolean;
    linkPrev?: { id?: string | null; title?: string | null; artist?: string | null } | null;
    linkClockAt?: number | null;
  } | null | undefined,
  predecessor: { id?: string | null; title?: string | null } | null,
  opts: { voiceAllowed?: boolean; wavExists?: (path: string) => boolean; nowMs?: number } = {},
): boolean {
  if (!item) return false;
  if (opts.voiceAllowed === false) return false;
  const canSpeak = !!item.introScript
    || (!!item.introWav && (opts.wavExists ? opts.wavExists(item.introWav) : true));
  if (!canSpeak) return false;
  if (opts.nowMs != null && linkClockDrifted(item.linkClockAt, opts.nowMs)) return false;
  return !shouldDropStaleLink(item, predecessor);
}

// Which mixer channel a spoken clip takes: 'intro' → intro.txt → intro_queue →
// LIGHT duck (p=0.30, the music stays audible under the voice), 'say' →
// say.txt → voice_queue → HEAVY duck (p=0.22, the voice dominates).
//
// The rule is **what the clip plays OVER, not what kind it is**. A link talks
// up the song that just started, so the song stays up. Everything else — idents,
// the hourly clock, weather, a request intro — is meant to dominate.
//
// `overBed` is the #1465 case and it OVERRIDES the kind: a clip airing on an
// instrumental bed has no song to talk over, and the heavy duck would push the
// bed (put there for exactly this purpose) down to a hiss. It is the CALLER's
// observation that a bed is on air — `queue.onBedStarted` saw the marker —
// never `item.bedded`, which only means a bed URI reached next.txt. A pushed
// item is handed over, never playable: an unresolvable URI is dropped in
// silence and a marker missed by more than BED_MARKER_FRESH_MS never fires the
// event, and in both cases the SONG starts and the line airs over its opening,
// which is a song to talk over and takes the heavy duck like any other request
// intro. Reading the flag would hand that failure — the one this feature exists
// to prevent — a lighter duck than it had pre-#1465.
//
// Pure + exported so the rule is unit-pinned (scripts/voice-channel.test.ts)
// and stated once: `announce` and `airIntro` both reach it, and each had its own
// inline copy. `airPendingVoice` deliberately does NOT — a boundary-deferred
// ident is a say-kind clip forced onto the intro channel (#1382), which is an
// exception to this rule rather than an instance of it.
export function voiceChannelFor(
  kind: string | null | undefined,
  { overBed = false }: { overBed?: boolean } = {},
): 'intro' | 'say' {
  return (overBed || kind === 'link') ? 'intro' : 'say';
}

// Per-target-file write chain. Liquidsoap polls each handoff file (say.txt,
// intro.txt, sfx.txt, next.txt, jingle-now.txt) on a 0.5-1.0s interval and
// DELETES the file
// after reading it (see liquidsoap/radio.liq poll_voice/poll_intro/poll_sfx/
// poll_queue). Without serialisation, two writes inside one poll window
// silently lose the first one — exactly the failure in issue #140 where a
// station ID rendered + logged but never aired.
//
// writeHandoff() serialises writes per file and waits for the previous WAV/URI
// to be consumed (file deleted by liquidsoap) before releasing the lock. If
// liquidsoap is dead/stuck and never deletes, we time out after maxWaitMs and
// release anyway — better to overwrite a stuck file than block all future
// announces forever.

export function formatAgo(ms: number) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${Math.max(1, s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// The attribution a multi-voice exchange line carries off the mic.
//
// A rotated line is spoken by whoever holds the mic for it — a guest co-host,
// not the session's host — and TWO surfaces downstream depend on being told so.
// `logText` prefixes the booth log with the speaker; `meta.personaId` is what
// session.windowMessages() and broadcast/prompt-memory.ts both key off to name
// the real speaker instead of handing a guest's words to the host as their own.
// Lived inline in announceExchange, where the shape it owes those two readers
// could drift without anything noticing.
export function exchangeSegment(
  line: { persona?: { id?: string; name?: string } | null; text: string },
  kind: string,
): {
  kind: string; channel: 'say'; text: string;
  persona: { id?: string; name?: string } | null;
  logText: string;
  meta: { personaId?: string; personaName?: string };
  legacy: false;
} {
  const name = line.persona?.name;
  return {
    kind,
    channel: 'say',
    text: line.text,
    persona: line.persona ?? null,
    logText: `${name ? `${name}: ` : ''}${line.text}`,
    meta: { personaId: line.persona?.id, personaName: name },
    // The aggregate dj.say the exchange publishes covers the legacy channel for
    // the whole conversation; voice.start/voice.end still fire per line.
    legacy: false,
  };
}
