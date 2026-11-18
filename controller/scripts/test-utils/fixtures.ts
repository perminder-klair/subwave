// Replaces seven identical 24-hour day arrays. Each day owns a separate array,
// so tests can change one show boundary without changing the rest of the week.
export function weekFor<ShowId extends string | null>(showId: ShowId): Record<number, ShowId[]> {
  const week: Record<number, ShowId[]> = {};
  for (let day = 0; day < 7; day++) week[day] = Array(24).fill(showId);
  return week;
}
