// Resolves the active music source from settings.music.source, caching the
// resolved instance. Mirrors llm/internal/provider/registry.ts: the cache is
// keyed by a signature that changes whenever the relevant config changes, so a
// settings edit is picked up on the next call with NO explicit invalidation.
//
// Part A's signature is just the source id — the subsonic source reads
// config.navidrome at call time (buildUrl), so credential changes (the
// onboarding overlay) flow through live without touching this cache. Part B's
// local source appends its root path to the signature.

import * as settings from '../../settings.js';
import { config } from '../../config.js';
import { subsonicSource } from './subsonic.js';
import { localSource } from './local.js';
import type { MusicSource } from './types.js';

// `|| { source: 'subsonic' }` keeps this safe before the settings key exists
// (fresh load → DEFAULTS) and against a hand-edited settings.json — same spirit
// as the LLM registry's llmCfg().
export function musicCfg(): { source: string } {
  return (settings.get() as any).music || { source: 'subsonic' };
}

const cache = new Map<string, MusicSource>();

export function activeSource(): MusicSource {
  const cfg = musicCfg();
  // Signature includes the local root so a MUSIC_DIR change re-resolves; the
  // subsonic source reads config.navidrome at call time, so its creds need no
  // signature bit.
  const sig = cfg.source === 'local' ? `local|${config.music.localDir}` : cfg.source;
  const hit = cache.get(sig);
  if (hit) return hit;

  let src: MusicSource;
  switch (cfg.source) {
    case 'local':
      src = localSource;
      break;
    case 'subsonic':
    default:
      src = subsonicSource;
      break;
  }
  cache.set(sig, src);
  return src;
}

export function activeSourceId(): string {
  return activeSource().id;
}
