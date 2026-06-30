import * as settings from '../../settings.js';

// Lazy imports — avoids circular deps and lets the router swap at runtime.
let _navidrome: any = null;
let _plex: any = null;

async function loadNavidrome() {
  if (!_navidrome) _navidrome = await import('../subsonic.js');
  return _navidrome;
}

async function loadPlex() {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore -- plex.ts added in a later task; dynamic import is intentional
  if (!_plex) _plex = await import('../plex.js');
  return _plex;
}

export function getSource(): any {
  const source = (settings.get() as any).music?.source || 'navidrome';
  if (source === 'plex') {
    if (!_plex) {
      // Synchronous fallback: trigger load but return Navidrome until ready.
      // In practice plex.ts is always pre-loaded by the time any route fires.
      loadPlex().catch(console.error);
    }
    return _plex || _navidrome;
  }
  if (!_navidrome) loadNavidrome().catch(console.error);
  return _navidrome;
}

// Sync version for use in non-async contexts (after warm-up).
export function getSourceSync(): any {
  const source = (settings.get() as any).music?.source || 'navidrome';
  return source === 'plex' ? (_plex || _navidrome) : (_navidrome || _plex);
}

// Pre-warm both backends at startup so getSource() is synchronous in routes.
// Both are always loaded — plex.ts is safe to import without credentials
// (no network calls at import time) and reads config at call time, so a
// source switch is instant without needing to reload the module.
export async function warmSourceCache() {
  await loadNavidrome();
  await loadPlex().catch(() => { /* no-op if plex.ts fails to import */ });
}

export function invalidateSourceCache() {
  // Both modules read config.plex at call time — no need to clear _plex.
  // Re-warm eagerly so a source switch to Plex is immediately ready.
  warmSourceCache().catch(console.error);
}
