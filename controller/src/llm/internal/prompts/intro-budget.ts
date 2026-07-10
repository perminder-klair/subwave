// Talk-within-the-intro: turn a track's measured intro runway into an advisory
// spoken-line budget (introBudgetPhrase) and a deterministic hard backstop
// (enforceIntroBudget) so the DJ lands before the vocals enter. Both are
// no-ops for un-analysed tracks — the post is a bonus when the data exists,
// never a precondition.

import * as library from '../../../music/library.js';

// Intro runway (ms to where the track 'comes in') for a track, from the track
// object or a library lookup. Null when un-analysed.
export function introMsFor(track: any): number | null {
  if (track?.introMs != null) return track.introMs;
  const rec = track?.id ? library.get(track.id) : null;
  return rec?.introMs ?? null;
}

// Delegates to library.bpmKeyFor — the shared resolver that prefers the
// analyzer's numbers and treats Navidrome's ID3-derived `bpm: 0` as unknown
// rather than "carries analysis" (#862).
export function bpmKeyFor(track: any): { bpm: number | null; key: string | null } {
  return library.bpmKeyFor(track);
}

// Advisory spoken-line budget (Stage A.3 phase 1). Returns '' when there's no
// usable runway, so un-analysed tracks are never constrained.
export function introBudgetPhrase(introMs: number | null | undefined): string {
  if (!introMs || introMs < 2500) return '';
  if (introMs >= 18000) return '';
  const sec = Math.floor(introMs / 1000);
  if (introMs < 6000) {
    return `The track's vocals come in around ${sec}s — keep this to a single short phrase that finishes before then; never run past it.`;
  }
  return `The track's vocals come in around ${sec}s — you have room for a sentence or two; use it, but land your last word before then rather than talking over the vocals.`;
}

// Hard backstop for talk-within-the-intro (Stage A.3 phase 2): the budget PHRASE
// above is advisory — a small model will still occasionally overrun. This
// enforces it deterministically. Base speaking pace is ~2.5 words/sec, scaled
// by `paceScale` — the live speech-rate multiplier from
// audio/tts.speechPaceScale() (engine × persona × daypart) — so a persona
// speaking at 0.8× gets a proportionally smaller word ceiling; 1 (the
// default) is the historical fixed-pace assumption.
//
// A spoken fragment sounds like a station failure, so this NEVER hard-cuts
// mid-thought (#962): over-long lines trim to the last complete sentence that
// fits, else the last clause boundary (closed with a period so it still
// sounds intentional), else the line is DROPPED — callers treat '' as "no
// spoken intro" and the track just plays. Returns the text unchanged when
// there's no usable runway (null, very short, or a long ≥18s intro) —
// symmetric with introBudgetPhrase's guards.
export function enforceIntroBudget(text: string, introMs: number | null | undefined, paceScale = 1): string {
  const t = (text || '').trim();
  if (!t || !introMs || introMs < 2500 || introMs >= 18000) return t;
  const BASE_WORDS_PER_SEC = 2.5;
  const pace = (Number.isFinite(paceScale) && paceScale > 0) ? paceScale : 1;
  const maxWords = Math.max(3, Math.floor((introMs / 1000) * BASE_WORDS_PER_SEC * pace));
  const words = t.split(/\s+/);
  if (words.length <= maxWords) return t;

  const capped = words.slice(0, maxWords).join(' ');
  // Last index of a boundary character that ends a word (followed by space or
  // end-of-string) — so a decimal ("3.5") or a thousands comma ("1,200")
  // never counts as a cut point. `skip` vetoes individual matches.
  const lastBoundary = (re: RegExp, skip?: (m: RegExpExecArray) => boolean): number => {
    let at = -1;
    for (let m = re.exec(capped); m; m = re.exec(capped)) {
      if (!skip || !skip(m)) at = m.index;
    }
    return at;
  };
  // A period after an abbreviation or a lone initial ("Dr.", "St.", "feat.",
  // "E. Street") is not a sentence end — without this veto the cut lands right
  // after it and the DJ airs "Dr." alone, the exact fragment this cascade
  // exists to prevent. Vetoing too eagerly is safe (the line falls through to
  // the clause/drop steps); accepting wrongly is not. Applies to '.' only —
  // '!' and '?' never end abbreviations.
  const ABBREV_BEFORE_STOP = /(?:^|\s)(?:[A-Za-z]|Dr|Mr|Mrs|Ms|St|Jr|Sr|Prof|Rev|Sgt|Capt|Lt|Gen|Col|Mt|No|vs|feat|ft)$/i;
  // Prefer the last complete sentence, however short — a one-word "Nice."
  // sounds intentional; a fragment never does.
  const lastStop = lastBoundary(
    /[.!?](?=\s|$)/g,
    (m) => m[0] === '.' && ABBREV_BEFORE_STOP.test(capped.slice(0, m.index)),
  );
  if (lastStop > 0) return capped.slice(0, lastStop + 1).trim();
  // No full sentence fits — keep the longest clause if it carries enough of
  // the line to stand alone, closed with a period.
  const lastClause = lastBoundary(/[,;:—](?=\s|$)/g);
  if (lastClause >= Math.floor(capped.length * 0.4)) {
    return capped.slice(0, lastClause).trim() + '.';
  }
  // Nothing complete fits the runway — silence beats an ellipsis fragment.
  return '';
}
