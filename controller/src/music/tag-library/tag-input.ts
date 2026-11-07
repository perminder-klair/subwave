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
// One writer, `recordTagAnswer`, stores every LLM answer, from the bulk batch
// loop and the admin Retag route alike, so neither can save an empty answer as
// a tag.
//
// `model` is the label of the leg the caller asked: in dual-LLM mode each pinned
// leg's own, otherwise the primary's, even when the unpinned call failed over and
// the fallback answered. The LLM layer does not report which leg answered, and
// the same label is the `model` stamp on a tagged row.

import { createHash } from 'node:crypto';
import * as db from '../library-db.js';
import type { TaggableSong, TagResult } from '../tagger-core.js';

export function tagInputFor(t: db.TrackRecord): TaggableSong {
  return {
    title: t.title ?? undefined,
    artist: t.artist ?? undefined,
    album: t.album ?? undefined,
    year: t.year ?? undefined,
    genres: t.genres,
  };
}

export function untaggableKey(input: TaggableSong, promptHash: string, model: string): string {
  return createHash('sha256').update(JSON.stringify([input, promptHash, model])).digest('hex');
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
