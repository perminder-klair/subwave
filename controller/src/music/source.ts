// Music source accessor + registry.
//
// SUB/WAVE's model is: the server holds decodable audio, the controller writes a
// track URI to next.txt, Liquidsoap plays/crossfades/ducks it. Historically the
// only source was a Subsonic server (Navidrome), imported directly at ~80 call
// sites. getSource() is the seam that lets other catalogues — Jellyfin, Jamendo,
// a local folder — back the same picker/request/queue pipeline without those call
// sites naming a provider.
//
// The interface, the Song type, the id helpers, the annotate builder and the
// connection-config resolver live in source-kit.ts (which the providers import);
// this module owns the registry + the active-source accessor and re-exports the
// kit so existing call sites keep importing everything from './source.js'.
//
// SINGLE active source for now: getSource() resolves the one provider named in
// settings (env MUSIC_SOURCE wins). Ids are namespaced at the boundary
// (nd:/jf:/jam:/local:) so a future multi-source picker can route per-id.

import type { MusicSource } from './source-kit.js';
import { sourceConfig } from './source-kit.js';
import { navidromeSource } from './sources/navidrome.js';
import { jamendoSource } from './sources/jamendo.js';
import { jellyfinSource } from './sources/jellyfin.js';
import { localSource } from './sources/local.js';

export * from './source-kit.js';

type SourceBuilder = () => MusicSource;

const REGISTRY: Record<string, SourceBuilder> = {
  navidrome: () => navidromeSource,
  subsonic: () => navidromeSource, // alias — same Subsonic client, any compatible server
  jamendo: () => jamendoSource,
  jellyfin: () => jellyfinSource,
  local: () => localSource,
};

let cached: { key: string; source: MusicSource } | null = null;

export function getSource(): MusicSource {
  const key = sourceConfig().provider || 'navidrome';
  if (cached && cached.key === key) return cached.source;
  const build = REGISTRY[key] || REGISTRY.navidrome;
  const source = build();
  cached = { key, source };
  return source;
}

// Look up a specific provider by key (for prefix-routed /cover/:id). Falls back
// to the active source when the key is unknown/unconfigured — single-source means
// foreign-prefixed ids shouldn't occur, but be forgiving rather than 500.
export function getSourceByKey(key: string | null | undefined): MusicSource {
  if (key && REGISTRY[key]) return REGISTRY[key]();
  return getSource();
}

// Register an additional provider builder (later phases). Idempotent.
export function registerSource(key: string, build: SourceBuilder): void {
  REGISTRY[key] = build;
}

// Drop the cache so the next getSource() re-reads settings — called after a
// settings.update() that may have changed the active provider.
export function invalidateSource(): void {
  cached = null;
}
