// Resolve era from original-release metadata or a manual override. Use year only when it
// describes the recording; blank, nonfinite, or nonpositive years are unknown. #842, #1418.
export function resolveEraYear(
  year: number | string | null | undefined,
  originalYear: number | null | undefined,
  yearUntrusted: boolean | null | undefined,
): number | null {
  const oy = Number(originalYear);
  if (Number.isFinite(oy) && oy > 0) return oy;
  if (yearUntrusted) return null;
  const y = Number(year);
  return Number.isFinite(y) && y > 0 ? y : null;
}
