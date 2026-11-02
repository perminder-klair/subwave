// The embed text's Sound: line (#1246): the words a track's measured acoustics
// give formatTrackText. Pure, so library-db can tell whether a write moved the
// words a stored vector was built from (#2236) without importing the embedding
// layer (ai, the provider, settings).
//
// Two parts, because two writers own them and a re-analyze lands them at
// different times: each track's analysis write brings the measured words (tempo,
// key mode, instrumental), and the zero-shot mood pass brings the CLAP moods
// after the whole pass. clearAnalysis wipes both, so a per-track write compared
// against the whole line would find the moods missing and mark every row of an
// identical re-analyze. Each writer compares only its own part.

import { isInstrumental, type VocalEvidence } from './lyric-vocal.js';
import type { TrackRecord } from './library-db/types.js';

// Measured acoustics from the analyzer pass (#1246). Never the tagger's own
// `moods` / `energy`: those are decided from these vectors, so feeding them
// back is circular. VocalEvidence is tracks.vocal_ranges plus the tail's spans:
// sung duration decides instrumental status, and null/undefined = not computed.
export interface TrackAcoustics extends VocalEvidence {
  bpm?: number | null;
  musicalKey?: string | null;      // Camelot code, e.g. '8A'
  // Zero-shot CLAP moods (music/audio-moods.ts). Heavy analyzer tier only.
  audioMoods?: string[] | null;
  // The pace curve is deliberately not an input: its range (~0.02–0.5) makes a
  // fixed threshold stamp one word on ~everything.
}

export interface SoundWords {
  moods: string[];     // the zero-shot mood pass's labels
  measured: string[];  // the analysis pass's: tempo band, key mode, instrumental
}

export type SoundPart = keyof SoundWords;

// Tempo as a word, not a number: "128" embeds as an arbitrary token.
function tempoWord(bpm: number): string | null {
  if (!Number.isFinite(bpm) || bpm <= 0) return null;   // 0 = unknown, never "very slow"
  if (bpm < 80) return 'slow tempo';
  if (bpm < 105) return 'mid-tempo';
  if (bpm < 130) return 'upbeat tempo';
  return 'fast tempo';
}

// Only the mode of a Camelot code is legible ('A' = minor, 'B' = major); the
// tonic number stays out. Positions outside 1-12 yield null.
function keyModeWord(camelot: string): string | null {
  const m = /^\s*(?:[1-9]|1[0-2])\s*([AB])\s*$/i.exec(camelot);
  if (!m) return null;
  return m[1].toUpperCase() === 'A' ? 'minor key' : 'major key';
}

// The Sound: words by part, each in a stable order (the same input must always
// produce the same vector). Both empty when nothing was analysed.
export function soundWords(acoustics?: TrackAcoustics | null): SoundWords {
  const words: SoundWords = { moods: [], measured: [] };
  if (!acoustics) return words;
  for (const m of acoustics.audioMoods ?? []) {
    const t = String(m || '').trim();
    if (t) words.moods.push(t);
  }
  const tempo = acoustics.bpm != null ? tempoWord(Number(acoustics.bpm)) : null;
  if (tempo) words.measured.push(tempo);
  const mode = acoustics.musicalKey ? keyModeWord(acoustics.musicalKey) : null;
  if (mode) words.measured.push(mode);
  // [] is a measurement ("no vocals found"), null is its absence.
  if (isInstrumental(acoustics) === true) {
    words.measured.push('instrumental');
  }
  return words;
}

// The Sound: line's words in the order it prints them: moods, then measured.
export function soundDescriptors(acoustics?: TrackAcoustics | null): string[] {
  const { moods, measured } = soundWords(acoustics);
  return [...moods, ...measured];
}

export type AcousticsFields = Pick<TrackRecord,
  'bpm' | 'musicalKey' | 'audioMoods' | 'vocalRanges' | 'vocalRangesInvalid' |
  'tailVocalRanges' | 'tailVocalRangesInvalid'>;

// A stored track's acoustics, the one mapping every embed path uses, so the bulk
// pass and the retag route build the same text. Measured acoustics only: phases
// 2-4 vote over the graph these vectors form, so nothing the tagger decides may
// enter here.
export function trackAcoustics(t: AcousticsFields): TrackAcoustics {
  return {
    bpm: t.bpm, musicalKey: t.musicalKey, audioMoods: t.audioMoods,
    vocalRanges: t.vocalRanges,
    vocalRangesInvalid: t.vocalRangesInvalid,
    tailVocalRanges: t.tailVocalRanges,
    tailVocalRangesInvalid: t.tailVocalRangesInvalid,
  };
}
