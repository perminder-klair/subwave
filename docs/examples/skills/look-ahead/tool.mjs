export const description = 'Choose up to two prepared shows later today, excluding the next scheduled show. Returns exact times, titles, presenters and editorial briefs, with the speaking DJ’s role. Stand down if nothing qualifies.';
export const requiresData = true;
// Chance of a solo promo voiced by an upcoming host; keep this out of the skill UI.
const GUEST_PROMO_PERCENT = 33;
export const ready = services => typeof services.schedule?.laterToday === 'function';

export default async function lookAhead(ctx, state, services) {
  if (!ready(services)) return { available: false, reason: 'Schedule service unavailable' };
  const snapshot = services.schedule.laterToday();
  // Cross-tick rotation after the durable first-offer markers are exhausted.
  if (state.rotation?.day !== snapshot.day) state.rotation = { day: snapshot.day, sequence: 0, offered: {} };
  const rotation = state.rotation;
  const shows = snapshot.shows
    .map(show => ({ show, offered: services.recall.seen(`look-ahead:offered:${show.occurrenceId}`), lastOffered: rotation.offered[show.occurrenceId] ?? 0, rank: Math.random() }))
    .sort((a, b) => Number(a.offered) - Number(b.offered) || a.lastOffered - b.lastOffered || a.rank - b.rank)
    .slice(0, 2).map(item => item.show)
    .sort((a, b) => a.startsAt - b.startsAt);
  if (!shows.length) return { available: false, reason: 'No eligible shows later today beyond the next scheduled show' };
  const candidates = shows.filter(show => show.host?.id && show.host.id !== snapshot.speaker?.id);
  const promo = snapshot.speaker && candidates.length && Math.random() * 100 < GUEST_PROMO_PERCENT
    ? candidates[Math.floor(Math.random() * candidates.length)] : null;
  const selected = promo ? [{ ...promo, speakerRole: 'host' }] : shows;
  const speaker = promo ? promo.host : snapshot.speaker;
  // Only mark the shows actually offered for this segment, not the unused candidate.
  for (const show of selected) {
    services.recall.remember(`look-ahead:offered:${show.occurrenceId}`);
    rotation.offered[show.occurrenceId] = ++rotation.sequence;
  }
  return { available: true, speechFormat: 'look-ahead', mode: promo ? 'upcoming-host-promo' : 'current-dj',
    speakerIds: speaker ? [speaker.id] : [],
    promoOccurrenceId: promo?.occurrenceId ?? null, day: snapshot.day, timezone: snapshot.timezone,
    speaker, when: 'All listed shows air later TODAY. Mention every listed show using its exact startTime.',
    shows: selected, lookAheadStamp: snapshot.lookAheadStamp };
}
