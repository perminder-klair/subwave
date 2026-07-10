// Unbiased Fisher–Yates shuffle. Returns a NEW array — the input is never
// mutated. Replaces the `[...arr].sort(() => Math.random() - 0.5)` idiom that
// was copied across the picker/scheduler/request paths: that sort is
// statistically biased (comparator isn't a consistent ordering, so elements
// don't land uniformly) and its result depends on the engine's sort. Kept
// generic + side-effect-free; no project imports.
export function shuffle<T>(arr: readonly T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
