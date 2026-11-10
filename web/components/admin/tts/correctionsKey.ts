// Key corrections by content to avoid invalidating samples on every render. JSON preserves embedded separators and distinguishes saved corrections from an empty list.
export interface CorrectionsPair { from: string; to: string }

export function correctionsKey(corrections: CorrectionsPair[] | undefined): string {
  return JSON.stringify(corrections ?? null);
}