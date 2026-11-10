// The tagging prompt's evidence line (#2281), as text: what the model is told
// was measured from a track's own audio, and what listeners tag it with. Pure,
// with no LLM import, so the untaggable key (tag-library/tag-input.ts) can hash
// the evidence exactly as the prompt renders it, and tagger-core's prompts
// print the same thing.

import { taggerSoundWords, type TaggerAcoustics } from './sound-line.js';

export interface TaggerEvidenceInput {
  acoustics?: TaggerAcoustics | null;
  lastfmTags?: string[] | null;
}

export interface TaggerEvidence {
  sound: string | null;
  lastfm: string | null;
}

// Enough to say what scene a track sits in; the merged track list can be longer.
const LASTFM_TAGS_SHOWN = 10;

// Whitespace collapsed, so a tag can never break the numbered list into a line
// that reads as another track.
function cleanLastfmTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  for (const t of tags) {
    const tag = typeof t === 'string' ? t.replace(/\s+/g, ' ').trim() : '';
    if (tag) out.push(tag);
    if (out.length >= LASTFM_TAGS_SHOWN) break;
  }
  return out;
}

// The evidence line's parts, each omitted when it has no signal, never printed
// empty (formatTrackText's rule): null when the track has neither.
export function formatEvidence(song: TaggerEvidenceInput): TaggerEvidence {
  const sound = taggerSoundWords(song.acoustics);
  const lastfm = cleanLastfmTags(song.lastfmTags);
  return {
    sound: sound.length ? `Sound: ${sound.join(', ')}` : null,
    lastfm: lastfm.length ? `Last.fm: ${lastfm.join(', ')}` : null,
  };
}
