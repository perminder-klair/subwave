// SQLite-backed library store.
//
// Replaces the JSON file (state/moods.json) the controller used to load into
// memory. Single source of truth for: per-track metadata, mood/energy tags,
// Last.fm + lyric enrichment cache, embedding vectors. Tags and vectors stay
// transactionally consistent because they live in one DB file.
//
// Loaded once per controller process (singleton). The tagger and the picker
// both go through this; reads are fast (page cache), writes commit per
// statement under WAL.
//
// This module is the public barrel. Every consumer imports it as a namespace
// (`import * as db from './library-db.js'`) and reaches the whole surface
// through it — import from here, never from ./library-db/* directly, so the
// public surface stays one file. The parts, in dependency order:
//
//   handle.ts       the open handle + shared constants (the no-cycle seam)
//   types.ts        record shapes; TrackRow is the raw SQLite row
//   rows.ts         row -> record mapping and the JSON column parsers
//   stats.ts        library-wide counts for the dashboard, briefly cached
//   schema.ts       migrations, versioned by PRAGMA user_version
//   legacy.ts       one-shot moods.json -> SQLite import
//   lifecycle.ts    open / close / backup / restore / reset
//   meta.ts         embedding-model metadata
//   tracks.ts       per-track reads and writes
//   vectors.ts      sqlite-vec KNN + the sound-map projection
//   audio-moods.ts  zero-shot moods scored from CLAP audio vectors
//   queries.ts      mood- and tag-keyed reads, genre centroids
//   browse.ts       the admin browse filter + Observatory rows
//   plays.ts        play history

export * from './library-db/handle.js';
export * from './library-db/types.js';
export * from './library-db/rows.js';
export * from './library-db/stats.js';
export * from './library-db/schema.js';
export * from './library-db/legacy.js';
export * from './library-db/lifecycle.js';
export * from './library-db/meta.js';
export * from './library-db/tracks.js';
export * from './library-db/vectors.js';
export * from './library-db/audio-moods.js';
export * from './library-db/id-adoption.js';
export * from './library-db/queries.js';
export * from './library-db/browse.js';
export * from './library-db/plays.js';
