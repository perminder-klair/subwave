// What a listener reads about a show (#2358): the operator's `description`
// when set, else the DJ's `topic` brief, which is what every listener surface
// showed before the field existed. The one fallback rule every schedule, On
// Now card and skin goes through, so the two can never be chosen differently.
export function showBlurb(show: { description?: string | null; topic?: string | null } | null | undefined): string {
  const description = typeof show?.description === 'string' ? show.description.trim() : '';
  if (description) return description;
  return typeof show?.topic === 'string' ? show.topic.trim() : '';
}
