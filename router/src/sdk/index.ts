// Public entry for plugin authors. A plugin's entry module default-exports the
// result of defineSource():
//
//   import { defineSource } from '@subwave/source-sdk';
//   export default defineSource((ctx) => ({ async song(id) { … }, … }));
//
// defineSource is an identity function; it exists for type inference. A plain
// `export default (ctx) => ({ … })` loads just the same, which is what a
// dependency-free bundled .mjs plugin usually does.

import type { SourceFactory } from './types.js';

export * from './types.js';

export function defineSource(factory: SourceFactory): SourceFactory {
  return factory;
}

/** The albumartist convention for compilations, for backends with no compilation flag. */
export function isVariousArtists(albumArtist: unknown): boolean {
  const s = String(albumArtist ?? '').trim().toLowerCase();
  return s === 'various artists' || s === 'various' || s === 'va';
}
