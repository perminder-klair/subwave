// Pure ordering logic for speak()'s runtime rescue chain — extracted from
// tts.ts so scripts/tts-fallback.test.ts can pin it without dragging in the
// engine modules (settings reads, venv existsSyncs, live /health probes).
//
// Order: the operator's configured default engine first (their explicit second
// choice), then Piper (the universal local floor), then Kokoro (for the case
// where Piper itself was the failed primary). The primary, duplicates, and
// anything the caller's `usable` gate rejects are dropped — so the chain never
// re-attempts the engine that just threw, and never attempts one the
// pre-flight gate already knows can't speak.
export function orderedFallbacks(
  primary: string,
  defaultEngine: string | null | undefined,
  usable: (engine: string) => boolean,
): string[] {
  const out: string[] = [];
  for (const engine of [defaultEngine, 'piper', 'kokoro']) {
    if (!engine || engine === primary || out.includes(engine)) continue;
    if (!usable(engine)) continue;
    out.push(engine);
  }
  return out;
}
