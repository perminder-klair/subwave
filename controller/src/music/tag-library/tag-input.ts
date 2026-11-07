// What the tagger sends the LLM for one track, and the untaggable memory keyed
// on it (#2283).
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

import { createHash } from 'node:crypto';
import * as db from '../library-db.js';
import type { TaggableSong } from '../tagger-core.js';

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
