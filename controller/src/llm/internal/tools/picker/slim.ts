// The slim track shape every discovery tool returns.
//
// One projection, shared by every tool, so the model sees the same fields with
// the same names whichever way it reached a track — stable ids to reference and
// enough signal to reason about flow.

import * as subsonic from '../../../../music/subsonic.js';
import * as library from '../../../../music/library.js';
import { durationSeconds } from '../../../../music/recency.js';
import { unairedFlag } from '../../../../music/airing.js';
import { resolveEraYear } from '../../../../music/show-filter.js';

export function slim(s: any) {
  // Surface the editorial tags + measured acoustic facts when known — merged
  // per field from the song itself (library sources, via slimTrack) and a
  // library lookup (Subsonic sources). The lookup always runs: Subsonic songs
  // are raw Navidrome children that never carry moods/energy/pace, and their
  // ID3-derived `bpm: 0` used to pass an all-or-nothing "carries analysis?"
  // guard here and skip the lookup entirely, blanking every field for that
  // song (#862). Measured acoustics prefer the analyzer's number (library
  // record) over the file's ID3 tag. Each field is omitted when absent so the
  // agent only ever sees real values. `moods`/`energy` are the station's
  // tagging vocabulary; `instrumental` is derived from vocalRanges; `pace`
  // (0..1 perceptual energy) and `sections` (structural-part count over the
  // opening) feed FLOW reasoning per PICKER_CRITERIA in llm/dj.ts.
  const rec = s.id ? library.get(s.id) : null;
  // Era year, never the raw `year` (issue #1418) — this is the year the picker
  // reasons about flow and decade with, so a reissue anthology's date makes a
  // 1964 soul single look like 2010s material. #842 precedence via
  // resolveEraYear, reading the era fields off the candidate when it carries
  // them (library slimTrack rows) and off `rec` otherwise. Null when unknown,
  // same as any other field the agent is never shown a guess for.
  const eraYear = resolveEraYear(
    s.year ?? rec?.year,
    s.originalYear ?? rec?.originalYear,
    s.yearUntrusted ?? rec?.yearUntrusted ?? s.isCompilation ?? rec?.isCompilation,
  );
  const base = {
    id: s.id,
    title: s.title,
    artist: s.artist,
    album: s.album || null,
    year: eraYear,
    // Every genre tag, comma-joined ("Hip-Hop, Rap") — one compact field the
    // model reads as-is, whether the source is a raw Subsonic child (genres
    // [{name}] + scalar) or a library slimTrack row (genres string[]).
    genre: subsonic.songGenres(s).join(', ') || null,
  };
  const moods = Array.isArray(s.moods) && s.moods.length ? s.moods : (rec?.moods ?? []);
  const energy = s.energy ?? rec?.energy ?? null;
  // Length reads from whichever field the raw candidate carries (Subsonic
  // `duration`, library `durationSec`), so it's present even for an un-tagged
  // Subsonic track whose library lookup came back empty.
  const durationSec = durationSeconds(s) ?? durationSeconds(rec);
  // vocalRanges: [] = no vocal regions (instrumental), null/undefined = not
  // computed (unknown — omit rather than guess "has vocals").
  const vocalRanges = Array.isArray(s.vocalRanges) ? s.vocalRanges : rec?.vocalRanges;
  const instrumental = Array.isArray(vocalRanges) ? vocalRanges.length === 0 : null;
  // realBpm: a non-positive bpm means unknown — never emitted, never allowed
  // to mask the analyzed value.
  const bpm = library.realBpm(rec?.bpm) ?? library.realBpm(s.bpm);
  const key = rec?.musicalKey ?? s.musicalKey ?? null;
  const introMs = rec?.introMs ?? s.introMs ?? null;
  const pace = rec?.paceMean ?? s.paceMean ?? null;
  const sections = library.sectionCount(rec) ?? library.sectionCount(s);
  // Airing memory (music/airing.ts): true when the station has provably never
  // aired this track — the first-play discovery signal PICKER_CRITERIA's
  // VARIETY rule references. Omitted (not false) once the track has a play on
  // record, mirroring the pool picker's candidate payload, and also omitted
  // when the index can't answer at all: see unairedFlag for why an empty index
  // must not stamp `unaired: true` on every candidate at once.
  const unaired = unairedFlag(s, library.lastAiredInfo());
  return {
    ...base,
    ...(moods.length ? { moods } : {}),
    ...(energy != null ? { energy } : {}),
    ...(durationSec != null ? { duration_sec: durationSec } : {}),
    ...(instrumental != null ? { instrumental } : {}),
    ...(bpm != null ? { bpm } : {}),
    ...(key != null ? { key } : {}),
    ...(introMs != null ? { intro_ms: introMs } : {}),
    ...(pace != null ? { pace } : {}),
    ...(sections != null ? { sections } : {}),
    ...(unaired ? { unaired: true } : {}),
  };
}
