// What the tagger sends the LLM for one track, how its answer is stored, and the
// untaggable memory keyed on that input (#2283).
//
// The prompts tell the model to answer {"moods":[],"energy":"medium"} when it
// cannot tell, and a silent hidden track or a bare "Track 01" gets that answer
// every time. Nothing used to remember it, so the same tracks went to the LLM on
// every run, twice (the seed pass, then a phase-4 re-check). Now an empty answer
// leaves the row untagged with `untaggable_key` set to the hash of what was
// asked: this track's input, the prompt stamp (TAGGER_CONTRACT_VERSION plus the
// live mood vocabulary) and the model that answered. A run skips the track while
// that key still matches, so a metadata edit, a vocabulary or contract change,
// or another model asks again, and an operator's clear does too.
//
// One builder serves the call and the check. Anything added to the LLM's input
// belongs in `tagInputFor`, so it joins the key and a change to it re-asks.
// Since #2281 that includes the measured evidence (tempo, key mode, the vocal
// verdict, through taggerAcoustics) and the stored Last.fm tags. The key hashes
// that evidence as the prompt renders it (formatEvidence), not the raw
// measurements: new evidence is a new question, but a re-analysis that moves a
// BPM within its tempo band, or a vocal span by a few ms, asks the model exactly
// what it was asked before, so it is not asked again.
// One writer, `recordTagAnswer`, stores every LLM answer, from the bulk batch
// loop and the admin Retag route alike, so neither can save an empty answer as
// a tag.
//
// `model` is the label of the leg the caller asked: in dual-LLM mode each pinned
// leg's own, otherwise the primary's, even when the unpinned call failed over and
// the fallback answered. The LLM layer does not report which leg answered, and
// the same label is the `model` stamp on a tagged row.
//
// `recordTagAnswer` also writes the measured stamp (tracks.tagged_measured,
// #2281) from the same input, so it says what this answer heard. An untaggable
// answer writes no tag, so it writes no stamp either.

import { createHash } from 'node:crypto';
import * as db from '../library-db.js';
import { promptVocabHash } from '../embeddings.js';
import { activeModelLabel, fallbackLeg } from '../../llm/provider.js';
import { TAGGER_CONTRACT_VERSION, type TaggableSong, type TagResult } from '../tagger-core.js';
import { formatEvidence } from '../tagger-evidence.js';
import { hasTaggerSoundWords, taggerAcoustics } from '../sound-line.js';

export function tagInputFor(t: db.TrackRecord): TaggableSong {
  return {
    title: t.title ?? undefined,
    artist: t.artist ?? undefined,
    album: t.album ?? undefined,
    year: t.year ?? undefined,
    genres: t.genres,
    acoustics: taggerAcoustics(t),
    lastfmTags: t.lastfmTags,
  };
}

// The prompt stamp every LLM tag call is asked and stored with: the tagger
// contract plus the live mood vocabulary.
export function tagPromptStamp(): string {
  return promptVocabHash(TAGGER_CONTRACT_VERSION);
}

// Every label a run may stamp a marker with, from settings alone: the
// primary's, and in dual-LLM mode a configured fallback's. The run itself
// narrows this to the legs it can reach (resolveTagConsumers). Without that
// probe a marker from the fallback always reads as matching, which is right
// while the fallback is reachable: the run holds that row back too. When the
// probe finds the fallback unreachable, the run drops its label and asks
// those rows again through the primary, so they are work this count misses.
export function tagModelLabels(): string[] {
  const labels = [activeModelLabel()];
  const fb = fallbackLeg();
  if (fb && !labels.includes(fb.label)) labels.push(fb.label);
  return labels;
}

export function untaggableKey(input: TaggableSong, promptHash: string, model: string): string {
  // The evidence fields are hashed as formatEvidence renders them, not raw. A
  // new evidence field must be destructured out here and rendered through
  // formatEvidence too, or it lands in `metadata` and is hashed raw.
  const { acoustics: _acoustics, lastfmTags: _lastfmTags, ...metadata } = input;
  const asked = { ...metadata, evidence: formatEvidence(input) };
  return createHash('sha256').update(JSON.stringify([asked, promptHash, model])).digest('hex');
}

export interface TagStamp {
  source: db.TagSource;
  promptHash: string;
  model: string;
}

// Store one LLM answer for `id`, asked with `input`. An answer with no usable
// mood is untaggable: the row is left untagged and marked, never written as a
// `moods='[]'` tag.
export function recordTagAnswer(
  id: string, input: TaggableSong, result: TagResult, stamp: TagStamp,
): 'tagged' | 'untaggable' {
  if (result.moods.length === 0) {
    db.markTrackUntaggable(id, untaggableKey(input, stamp.promptHash, stamp.model));
    return 'untaggable';
  }
  db.upsertTrackTags(id, {
    moods: result.moods,
    energy: result.energy,
    source: stamp.source,
    confidence: null,
    promptHash: stamp.promptHash,
    model: stamp.model,
    taggedMeasured: hasTaggerSoundWords(input.acoustics),
  });
  return 'tagged';
}

// The untagged ids whose marker still matches what this run would ask, under
// any of the run's models (dual-LLM mode stamps each leg's own label).
export function rememberedUntaggable(promptHash: string, models: string[]): Set<string> {
  const out = new Set<string>();
  for (const { id, key } of db.untaggableMarks()) {
    const t = db.getTrack(id);
    if (!t) continue;
    const input = tagInputFor(t);
    if (models.some(m => untaggableKey(input, promptHash, m) === key)) out.add(id);
  }
  return out;
}
