// Pure lookups for the schedule drawer (#1621 on the web, #1848 here).
// Everything reads the /schedule payload the drawer already holds — never a
// second fetch, never a wider public shape.

import type { ActiveShow, SchedulePersona, ScheduleShow } from './types';

/** What the public roster gives us to say about a DJ: the tagline, plus the
 *  soul only when the station published souls. Absent is never invented. */
export function personaBlurbs(persona: SchedulePersona | null | undefined): string[] {
  if (!persona) return [];
  return [persona.tagline, persona.soul].map((v) => (v || '').trim()).filter(Boolean);
}

/** The on-air show's schedule entry, for its topic. /now-playing's activeShow
 *  carries no id, so the slot on air this hour wins when its name agrees, else
 *  the roster entry of that name (a takeover airs off the grid). */
export function onNowShow(
  activeShow: ActiveShow | null | undefined,
  slotShow: ScheduleShow | null | undefined,
  shows: ScheduleShow[] | null | undefined,
): ScheduleShow | null {
  const name = activeShow?.name;
  if (!name) return null;
  if (slotShow?.name === name) return slotShow;
  return (shows || []).find((s) => s.name === name) ?? null;
}

export function personaById(
  personas: SchedulePersona[] | null | undefined,
  id: string | null | undefined,
): SchedulePersona | null {
  if (!id) return null;
  return (personas || []).find((p) => p.id === id) ?? null;
}
