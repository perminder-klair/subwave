// Resolves the active music source from settings.music.source, caching the
// resolved instance. Mirrors llm/internal/provider/registry.ts (and upstream
// PR #843): the cache is keyed by the source id, so a settings edit is picked
// up on the next call with NO explicit invalidation.
//
// The subsonic source reads config.navidrome at call time (buildUrl), so
// credential changes (the onboarding overlay) flow through live without
// touching this cache.

import * as settings from '../../settings.js';
import { subsonicSource } from './subsonic.js';
import { spotifySource } from './spotify/source.js';
import type { MusicSource } from './types.js';

export const DEFAULT_MUSIC_SOURCE = 'subsonic';

// One entry per implementation; a new source is one import + one line here,
// and one entry in schemas/settings.ts MUSIC_SOURCES. Unknown ids resolve to
// subsonic — the same "fall back to the default" load() applies.
const registered = new Map<string, MusicSource>([
  [subsonicSource.id, subsonicSource],
  [spotifySource.id, spotifySource],
]);

// `|| { source: 'subsonic' }` keeps this safe before the settings key exists
// (fresh load → DEFAULTS) and against a hand-edited settings.json — same spirit
// as the LLM registry's llmCfg().
export function musicCfg(): { source: string } {
  const cfg = (settings.get() as any)?.music;
  return cfg && typeof cfg.source === 'string' ? cfg : { source: DEFAULT_MUSIC_SOURCE };
}

export function activeSource(): MusicSource {
  const { source } = musicCfg();
  return registered.get(source) ?? subsonicSource;
}

export function activeSourceId(): string {
  return activeSource().id;
}
