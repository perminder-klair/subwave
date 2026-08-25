import type { Persona } from './types';

export const PERSONA_SORTS = ['az', 'frequency', 'added'] as const;
export type PersonaSort = (typeof PERSONA_SORTS)[number];

export const PERSONA_SORT_LABELS: Record<PersonaSort, string> = {
  az: 'Name A–Z',
  frequency: 'Chattiest first',
  added: 'Date added',
};

// How often a persona speaks, most to least. Sorting on the stored STRING
// would put 'aggressive' above 'quiet' alphabetically, which is the wrong end
// of the dial and reads as a bug rather than a choice. Mirrors
// PERSONA_FREQUENCIES' own order; an unrecognised value sorts last rather than
// first, so a hand-edited settings.json can't quietly claim the top of the
// roster.
const FREQUENCY_RANK: Record<string, number> = {
  aggressive: 0, chatty: 1, moderate: 2, quiet: 3, silent: 4,
};
const frequencyRank = (p: Persona): number =>
  FREQUENCY_RANK[p.frequency] ?? Object.keys(FREQUENCY_RANK).length;

export interface PersonaRosterEntry {
  persona: Persona;
  // Position in the form array. RHF field paths, validation, deletion and
  // editing all key off this — never off display order.
  index: number;
  // 1-based position in the DISPLAYED roster. Human-facing counters and the
  // unnamed-persona placeholder read this, so what the operator is told
  // matches what they are looking at.
  position: number;
}

export interface PersonaRosterFilter {
  /** Free text over name, tagline and tags. */
  query: string;
  /** Selected tag chips — a persona matches if it carries ANY of them. */
  tags: string[];
}

export const EMPTY_PERSONA_FILTER: PersonaRosterFilter = { query: '', tags: [] };

export function personaFilterActive(f: PersonaRosterFilter): boolean {
  return f.query.trim() !== '' || f.tags.length > 0;
}

const PERSONA_NAME_COLLATOR = new Intl.Collator(undefined, {
  sensitivity: 'base',
  numeric: true,
});

/** Every tag in use across the roster, sorted — the chip row's vocabulary. */
export function personaTagVocabulary(personas: Persona[]): string[] {
  return [...new Set(personas.flatMap(p => p.tags || []))]
    .sort((a, b) => PERSONA_NAME_COLLATOR.compare(a, b));
}

function matches(p: Persona, f: PersonaRosterFilter): boolean {
  if (f.tags.length && !(p.tags || []).some(t => f.tags.includes(t))) return false;
  const q = f.query.trim().toLowerCase();
  if (!q) return true;
  return p.name.toLowerCase().includes(q)
    || p.tagline.toLowerCase().includes(q)
    || (p.tags || []).some(t => t.includes(q));
}

// Display order only: callers retain `index` for RHF field paths, validation,
// deletion and editing. Reordering the form array itself would turn a visual
// navigation aid into a persisted settings change.
//
// The on-air persona is pinned to the top under EVERY sort, filters included —
// "who is speaking right now" is the one thing an operator scanning this page
// is always looking for, and a sort that buries it makes the page worse the
// moment it has enough rows to need sorting. It is pinned, not exempted: a
// filter that excludes it still excludes it, because a roster that shows a row
// the filter rules out is lying about what matched.
export function orderPersonaRoster(
  personas: Persona[],
  onAirPersonaId: string,
  opts?: { sort?: PersonaSort; filter?: PersonaRosterFilter },
): PersonaRosterEntry[] {
  const sort = opts?.sort ?? 'az';
  const filter = opts?.filter ?? EMPTY_PERSONA_FILTER;
  return personas
    .map((persona, index) => ({ persona, index }))
    .filter(e => matches(e.persona, filter))
    .sort((left, right) => {
      const leftOnAir = left.persona.id === onAirPersonaId;
      const rightOnAir = right.persona.id === onAirPersonaId;
      if (leftOnAir !== rightOnAir) return leftOnAir ? -1 : 1;

      const leftName = left.persona.name.trim();
      const rightName = right.persona.name.trim();
      if (!leftName && rightName) return 1;
      if (leftName && !rightName) return -1;

      const byName = PERSONA_NAME_COLLATOR.compare(leftName, rightName);

      // 'added' is the form-array order, which is what this roster showed
      // before the name sort landed — kept as an explicit choice rather than
      // dropped, so an operator who has learned where their DJs sit can have
      // that back.
      if (sort === 'added') return left.index - right.index;
      if (sort === 'frequency') {
        const byFreq = frequencyRank(left.persona) - frequencyRank(right.persona);
        if (byFreq) return byFreq;
      }
      return byName || left.index - right.index;
    })
    .map((entry, position) => ({ ...entry, position: position + 1 }));
}
