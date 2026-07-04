// TEMPORARY compat shim — deleted in the call-site-flip commit of the
// pluggable-music-source refactor. Lets call sites that still
// `import * as subsonic from '../music/subsonic.js'` keep compiling while they
// are migrated to the facade (music/source.js) one commit at a time.
//
// The song/URL/discovery functions still live in sources/subsonic.js; the
// derived helpers (annotate, fuzzy resolvers, getRecentSongsByArtist) moved to
// the facade. Re-export both so the old namespace surface is intact.

export * from './sources/subsonic.js';
export {
  getAnnotatedUri,
  resolveGenreName,
  resolveArtist,
  getRecentSongsByArtist,
} from './source.js';
