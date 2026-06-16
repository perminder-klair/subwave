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

export function bpmKeyFor(track: any): { bpm: number | null; key: string | null } {
  if (track && (track.bpm != null || track.musicalKey != null)) {
    return { bpm: track.bpm ?? null, key: track.musicalKey ?? null };
  }
  const rec = track?.id ? library.get(track.id) : null;
  return { bpm: rec?.bpm ?? null, key: rec?.musicalKey ?? null };
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
// enforces it deterministically. Speaking pace is ~2.5 words/sec, so a known
// intro runway maps to a word ceiling; over-long lines are trimmed to the last
// sentence that fits, and only hard-cut mid-sentence if even one sentence won't
// fit. Returns the text unchanged when there's no usable runway (null, very
// short, or a long ≥18s intro) — symmetric with introBudgetPhrase's guards.
export function enforceIntroBudget(text: string, introMs: number | null | undefined): string {
  const t = (text || '').trim();
  if (!t || !introMs || introMs < 2500 || introMs >= 18000) return t;
  const WORDS_PER_SEC = 2.5;
  const maxWords = Math.max(3, Math.floor((introMs / 1000) * WORDS_PER_SEC));
  const words = t.split(/\s+/);
  if (words.length <= maxWords) return t;

  // Trim to the last sentence boundary that fits the budget.
  const capped = words.slice(0, maxWords).join(' ');
  const lastStop = Math.max(capped.lastIndexOf('.'), capped.lastIndexOf('!'), capped.lastIndexOf('?'));
  if (lastStop >= Math.floor(capped.length * 0.4)) {
    return capped.slice(0, lastStop + 1).trim();
  }
  // No sentence boundary worth keeping — hard cut and punctuate cleanly.
  return capped.replace(/[,;:\-—\s]+$/, '') + '…';
}
