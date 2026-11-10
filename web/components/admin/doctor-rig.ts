// What the DJ Doc rig drawing shows, derived from the report. Pure, so the
// rules can be pinned without rendering: which part of the rig each check
// section belongs to, what state each part is in, and which one gets circled.

import type { DoctorReport, DoctorReview, DoctorStatus } from './doctor-queries';

// Mirrors SECTION_CHECKS in controller/src/doctor.ts. The in-flight shimmer
// rows and the rig's "on the meter now" part key off it, so drift just
// mislabels which part is measuring for a few seconds; finished state comes
// from whatever actually arrived.
export const EXPECTED_SECTIONS = [
  'LLM',
  'Navidrome & library',
  'Broadcast',
  'Voice (TTS)',
  'Capabilities',
  'Content',
  'Resources',
  'Tuning',
  'Storage',
  'Setup',
];

export type RigPartId = 'brain' | 'crate' | 'mix' | 'voice' | 'extras';

/** The five parts DJ Doc's intro names, in its order. */
export const RIG_PARTS: ReadonlyArray<{ id: RigPartId; name: string; sections: readonly string[] }> = [
  { id: 'brain', name: 'The brain', sections: ['LLM', 'Tuning'] },
  { id: 'crate', name: 'The crate', sections: ['Navidrome & library', 'Content'] },
  { id: 'mix', name: 'The mix', sections: ['Broadcast'] },
  { id: 'voice', name: 'The voice', sections: ['Voice (TTS)'] },
  { id: 'extras', name: 'The extras', sections: ['Capabilities', 'Resources', 'Storage', 'Setup'] },
];

/** Not run yet, waiting its turn, being measured right now, or a verdict. */
export type RigState = 'idle' | 'pending' | 'measuring' | DoctorStatus;

/** A section the rig doesn't know (a newer controller) files under the extras. */
export function partOfSection(name: string): RigPartId {
  return RIG_PARTS.find(p => p.sections.includes(name))?.id ?? 'extras';
}

const RANK: Record<DoctorStatus, number> = { fail: 3, warn: 2, ok: 1, skip: 0 };

/** The worst finding wins; a part with nothing but skips (or nothing) is a skip. */
export function worstStatus(statuses: DoctorStatus[]): DoctorStatus {
  let worst: DoctorStatus = 'skip';
  for (const s of statuses) if (RANK[s] > RANK[worst]) worst = s;
  return worst;
}

export function rigStates(report: DoctorReport | null, running: boolean): Record<RigPartId, RigState> {
  const out = {} as Record<RigPartId, RigState>;
  const arrived = new Set(report?.sections.map(s => s.name) ?? []);
  // The section the live run is waiting on: the first expected one not back yet.
  const onMeter = running ? EXPECTED_SECTIONS.find(n => !arrived.has(n)) : undefined;
  for (const part of RIG_PARTS) {
    if (!report) {
      out[part.id] = 'idle';
      continue;
    }
    const waiting = running && EXPECTED_SECTIONS.some(n => partOfSection(n) === part.id && !arrived.has(n));
    if (waiting) {
      out[part.id] = onMeter && partOfSection(onMeter) === part.id ? 'measuring' : 'pending';
      continue;
    }
    const statuses = report.sections
      .filter(s => partOfSection(s.name) === part.id)
      .flatMap(s => s.findings.map(f => f.status));
    out[part.id] = worstStatus(statuses);
  }
  return out;
}

/** The part to circle: where DJ Doc's top priority's fix lives, or failing
 *  that the first part with the worst verdict. Nothing to circle while a run
 *  is still coming in, or when every part is clean. */
export function fixFirstPart(
  report: DoctorReport | null,
  review: DoctorReview | null,
  states: Record<RigPartId, RigState>,
): RigPartId | null {
  if (!report) return null;
  if (RIG_PARTS.some(p => states[p.id] === 'pending' || states[p.id] === 'measuring')) return null;
  const fixId = review?.available ? review.priorities?.[0]?.fixId : null;
  if (fixId) {
    const sec = report.sections.find(s => s.findings.some(f => f.fix?.id === fixId));
    if (sec) return partOfSection(sec.name);
  }
  for (const want of ['fail', 'warn'] as const) {
    const hit = RIG_PARTS.find(p => states[p.id] === want);
    if (hit) return hit.id;
  }
  return null;
}

/** The first section of a part that the report actually holds, to jump to. */
export function firstSectionOf(report: DoctorReport | null, part: RigPartId): string | null {
  return report?.sections.find(s => partOfSection(s.name) === part)?.name ?? null;
}

/** A stable DOM id for a section's row in the rundown. */
export function sectionAnchor(name: string): string {
  return `doctor-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
}
