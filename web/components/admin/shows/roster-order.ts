// Display order and filtering for the /admin/shows list.
//
// The twin of personas/roster-order.ts, and it makes the same load-bearing
// call: this changes only what the operator LOOKS at. `index` — the position
// in the react-hook-form array — is carried on every entry, because RHF field
// paths (`shows.3.name`), per-row validation, Save show and delete all key off
// it. Sorting the form array itself would turn a navigation aid into a
// persisted settings write, and would renumber every open editor mid-edit.

import type { Persona, Show } from './types';

export const SHOW_SORTS = ['az', 'host', 'scheduled', 'added'] as const;
export type ShowSort = (typeof SHOW_SORTS)[number];

export const SHOW_SORT_LABELS: Record<ShowSort, string> = {
  az: 'Name A–Z',
  host: 'Host',
  scheduled: 'Most scheduled',
  added: 'Date added',
};

export interface ShowRosterEntry {
  show: Show;
  /** Position in the form array — the only thing RHF, Save and delete may use. */
  index: number;
  /** 1-based position in what is actually on screen, for human-facing counters. */
  position: number;
}

export interface ShowRosterFilter {
  /** Free text over name, topic and tags. Already trimmed by the caller or not
   *  — this lowercases and trims either way. */
  query: string;
  /** Selected tag chips. A show matches if it carries ANY of them (OR), which
   *  is what a chip row reads as; AND would make a second click empty the list. */
  tags: string[];
  /** '' = every host. */
  personaId: string;
}

export function showFilterActive(f: ShowRosterFilter): boolean {
  return f.query.trim() !== '' || f.tags.length > 0 || f.personaId !== '';
}

const NAME_COLLATOR = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** Every tag in use across the list, sorted — the chip row's vocabulary. */
export function showTagVocabulary(shows: Show[]): string[] {
  return [...new Set(shows.flatMap(s => s.tags || []))].sort((a, b) => NAME_COLLATOR.compare(a, b));
}

// Every field read here is guarded, and not out of habit: removing a show
// hands `watch` one frame where the dropped row still counts but holds only
// the editor's registered fields — no `topic`, maybe no `name`. The personas
// panel answers that with a memo (see PersonasPanel's note); this runs before
// the render that would throw, so it absorbs the frame instead.
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

function matches(show: Show, f: ShowRosterFilter): boolean {
  if (f.personaId && show.personaId !== f.personaId) return false;
  if (f.tags.length && !(show.tags || []).some(t => f.tags.includes(t))) return false;
  const q = f.query.trim().toLowerCase();
  if (!q) return true;
  // Tags are searchable as well as clickable: an operator who remembers the
  // word will type it before they scan a chip row of eight.
  return text(show.name).toLowerCase().includes(q)
    || text(show.topic).toLowerCase().includes(q)
    || (show.tags || []).some(t => t.includes(q));
}

/**
 * Filter, then order, then number.
 *
 * `added` is the form-array order — the order this list had before it grew a
 * sort control — and is kept as an explicit mode rather than dropped, because
 * an operator who has learned where their shows sit should be able to get that
 * back. It is not the default: creation order is exactly what stops being
 * navigable somewhere around the twentieth show.
 *
 * Every mode falls back to the name comparison and then to `index`, so the
 * order is total. Without that last tiebreak a re-render can reorder two shows
 * that compare equal — under `scheduled`, most of the list.
 */
export function orderShowRoster(
  shows: Show[],
  opts: { sort: ShowSort; filter: ShowRosterFilter; personas: Persona[]; hoursFor: (id: string) => number },
): ShowRosterEntry[] {
  const hostName = (show: Show): string =>
    opts.personas.find(p => p.id === show.personaId)?.name?.trim() || '';


  return shows
    .map((show, index) => ({ show, index }))
    .filter(e => matches(e.show, opts.filter))
    .sort((left, right) => {
      // A show with no name yet is one the operator just added and has not
      // finished; it sorts last rather than first under A–Z, where an empty
      // string would otherwise pin it to the top of every reload.
      const leftName = text(left.show.name).trim();
      const rightName = text(right.show.name).trim();
      const byName = (!leftName && rightName) ? 1
        : (leftName && !rightName) ? -1
        : NAME_COLLATOR.compare(leftName, rightName);

      if (opts.sort === 'added') return left.index - right.index;
      if (opts.sort === 'host') {
        const byHost = NAME_COLLATOR.compare(hostName(left.show), hostName(right.show));
        if (byHost) return byHost;
      }
      if (opts.sort === 'scheduled') {
        const byHours = opts.hoursFor(right.show.id) - opts.hoursFor(left.show.id);
        if (byHours) return byHours;
      }
      return byName || left.index - right.index;
    })
    .map((entry, position) => ({ ...entry, position: position + 1 }));
}
