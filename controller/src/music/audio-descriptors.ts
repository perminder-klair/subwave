// Sound descriptors: what CLAP can hear in a track (instruments, vocal type,
// production style), scored from the stored audio vectors like the audio moods
// (music/audio-descriptor-pass.ts). This module owns the vocabulary and every
// decision about a label. Pure. docs/internals/music.md has the reasoning.
//
// Descriptors are hints, never facts: they go in the embed text and the
// operator's dossier and nowhere else.

import crypto from 'node:crypto';
import { isInstrumental } from './lyric-vocal.js';
import {
  centeredScores,
  DEFAULT_MARGIN_SD,
  parseMoodStateHash,
  prunedBaselines,
  UNCALIBRATED_VERSION,
  type MoodBaselines,
} from './audio-calibration.js';

export type DescriptorGroup = 'instrument' | 'vocal' | 'production';

export interface Descriptor {
  label: string; // the word that reaches the Sound: line
  group: DescriptorGroup;
  prompt: string; // a caption, because CLAP was trained on audio captions
}

// Changing a prompt changes audioDescriptorVocabHash() and re-scores the library
// on the next pass. /embed-text takes at most 64 strings per call. Every prompt
// was checked against the real model (docs/internals/music.md): a word CLAP's
// tokenizer doesn't know scores as noise, so test a new label before adding it.
export const DESCRIPTOR_VOCAB: readonly Descriptor[] = [
  { label: 'piano', group: 'instrument', prompt: 'a person playing the piano, melodic piano keys' },
  { label: 'acoustic guitar', group: 'instrument', prompt: 'the sound of an acoustic guitar' },
  { label: 'electric guitar', group: 'instrument', prompt: 'distorted electric guitar riffs' },
  { label: 'synthesizer', group: 'instrument', prompt: 'the sound of a synthesizer' },
  { label: 'strings', group: 'instrument', prompt: 'a string section of violins and cellos' },
  { label: 'brass', group: 'instrument', prompt: 'the sound of brass instruments' },
  { label: 'saxophone', group: 'instrument', prompt: 'the sound of a saxophone' },
  { label: 'flute', group: 'instrument', prompt: 'the sound of a flute' },
  { label: 'organ', group: 'instrument', prompt: 'the sound of an organ' },
  { label: 'drum machine', group: 'instrument', prompt: 'programmed electronic drums and hi-hats' },
  { label: 'tabla', group: 'instrument', prompt: 'tabla drums from Indian classical music' },
  { label: 'harmonium', group: 'instrument', prompt: 'the sound of an Indian harmonium' },
  { label: 'dhol', group: 'instrument', prompt: 'the sound of dhol drums' },
  { label: 'sitar', group: 'instrument', prompt: 'the sound of a sitar' },
  { label: 'male vocals', group: 'vocal', prompt: 'a male singer singing a song' },
  { label: 'female vocals', group: 'vocal', prompt: 'a female singer singing a song' },
  { label: 'rap vocals', group: 'vocal', prompt: 'rap vocals over a hip hop beat' },
  { label: 'choir', group: 'vocal', prompt: 'a choir singing' },
  { label: 'lo-fi', group: 'production', prompt: 'lo-fi music' },
  { label: 'vintage recording', group: 'production', prompt: 'an old mono recording from the 1930s' },
  { label: 'orchestral', group: 'production', prompt: 'a full orchestra playing' },
  { label: 'heavy bass', group: 'production', prompt: 'the sound of heavy bass' },
  { label: 'dense mix', group: 'production', prompt: 'dense loud heavily compressed music' },
];

// Most labels one track may carry from each group.
export const DESCRIPTOR_GROUP_CAPS: Readonly<Record<DescriptorGroup, number>> = {
  instrument: 2,
  vocal: 1,
  production: 1,
};

// How far above its own library-wide mean, in sd, a label must sit to be
// selected. The threshold, not a top-K, keeps a label distinctive, and this value
// is what bounds it: by Cantelli's inequality at most 1 / (1 + k^2) of any
// distribution sits k sd above its mean, so no label can reach more than 24.6% of
// a library, whatever shape the library has.
export const DESCRIPTOR_MIN_Z = 1.75;

// Bump when selection changes, so stored labels are re-derived from the cosines
// on disk without a CLAP re-score. Rides the state hash beside the vocabulary.
export const DESCRIPTOR_CALIBRATION_VERSION = 1;

const GROUP_OF = new Map(DESCRIPTOR_VOCAB.map((d) => [d.label, d.group]));

// Hash of the labels, groups and prompts the stored scores were made with, kept
// in audio_embedding_meta.descriptor_vocab_hash. A mismatch re-scores.
export function audioDescriptorVocabHash(
  vocab: readonly Descriptor[] = DESCRIPTOR_VOCAB,
): string {
  const h = crypto.createHash('sha256');
  for (const d of vocab) h.update(`${d.group}/${d.label}=${d.prompt}|`);
  return h.digest('hex').slice(0, 16);
}

// The labels a track earns, in vocabulary group order and best-first inside each
// group. A label needs a calibrated z, so a library below the baseline floor
// selects nothing: unlike moods there is no raw fallback, because raw cosines
// rank the prompts rather than the tracks. The second of a group must also sit
// within the mood margin of the best: on the real model that is what tells a
// second instrument from a neighbouring timbre (acoustic guitar pulling in
// electric, any kick drum pulling in dhol).
export function selectAudioDescriptors(
  scores: Record<string, number>,
  baselines: MoodBaselines | null,
): string[] {
  const usable = prunedBaselines(baselines);
  if (!usable) return [];
  const z = centeredScores(scores, usable);
  const out: string[] = [];
  for (const group of Object.keys(DESCRIPTOR_GROUP_CAPS) as DescriptorGroup[]) {
    const earned = DESCRIPTOR_VOCAB
      .filter((d) => d.group === group && z[d.label] >= DESCRIPTOR_MIN_Z)
      .sort((a, b) => z[b.label] - z[a.label]);
    const floor = earned.length ? z[earned[0].label] - DEFAULT_MARGIN_SD : 0;
    for (const d of earned.slice(0, DESCRIPTOR_GROUP_CAPS[group])) {
      if (z[d.label] >= floor) out.push(d.label);
    }
  }
  return out;
}

// Whether a stored state hash means labels were selected at all. The state, not
// a count of rows: coverage reads this on a poll, and no labels exist until a
// pass has calibrated.
export function descriptorsSelected(storedState: string | null): boolean {
  const state = parseMoodStateHash(storedState);
  return !!state && state.version !== UNCALIBRATED_VERSION;
}

export interface DescribedTrack {
  audioDescriptors?: readonly string[] | null;
  vocalRanges?: unknown[] | null;
  vocalRangesInvalid?: boolean;
}

// What a consumer may read of a track's stored labels. isInstrumental owns the
// vocal question, so vocal labels are dropped here at use time, never at scoring
// time: a later change in the verdict flows through without a re-score.
export function usableDescriptors(track?: DescribedTrack | null): string[] {
  const labels = (track?.audioDescriptors ?? []).map((l) => String(l || '').trim()).filter(Boolean);
  if (isInstrumental(track?.vocalRanges, track?.vocalRangesInvalid) !== true) return labels;
  return labels.filter((l) => GROUP_OF.get(l) !== 'vocal');
}
