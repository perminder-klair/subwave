// Display order and filtering for /admin/shows; twin of personas/roster-order.
// Changes only what the operator LOOKS at: `index` (the react-hook-form array
// position) is carried on every entry because RHF field paths, validation, Save
// and delete all key off it. Never sort the form array itself.

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
  /** Free text over name, topic and tags; lowercased and trimmed here. */
  query: string;
  /** Selected tag chips; a show matches if it carries ANY of them (OR). */
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

// Every field read here is guarded: removing a show gives `watch` one frame
// where the dropped row holds only the editor's registered fields.
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

function matches(show: Show, f: ShowRosterFilter): boolean {
  if (f.personaId && show.personaId !== f.personaId) return false;
  if (f.tags.length && !(show.tags || []).some(t => f.tags.includes(t))) return false;
  const q = f.query.trim().toLowerCase();
  if (!q) return true;
  // Tags are searchable as well as clickable.
  return text(show.name).toLowerCase().includes(q)
    || text(show.topic).toLowerCase().includes(q)
    || (show.tags || []).some(t => t.includes(q));
}

/**
 * Filter, then order, then number. `added` is the form-array order, kept as an
 * explicit mode but not the default.
 *
 * Every mode falls back to the name comparison and then to `index` so the order
 * is total; without that tiebreak a re-render can reorder equal-comparing rows.
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
      // Unnamed shows sort last under A–Z rather than being pinned to the top.
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
