// SQLite-backed library store: per-track metadata, mood/energy tags, Last.fm +
// lyric enrichment, embedding vectors. One DB file, so tags and vectors stay
// transactionally consistent. Singleton per controller process, WAL mode.
//
// Public barrel: import this as a namespace, never ./library-db/* directly.
// The parts, in dependency order:
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
//   scenes.ts       the genre-tag vocabulary + its in-place merge
//   plays.ts        play history
//   stem-scan.ts    the stem backfill scope + its priority ranking

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
export * from './library-db/queries.js';
export * from './library-db/browse.js';
export * from './library-db/scenes.js';
export * from './library-db/plays.js';
export * from './library-db/stem-scan.js';
