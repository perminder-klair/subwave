import type { Persona } from './types';

export const PERSONA_SORTS = ['az', 'frequency', 'added'] as const;
export type PersonaSort = (typeof PERSONA_SORTS)[number];

export const PERSONA_SORT_LABELS: Record<PersonaSort, string> = {
  az: 'Name A–Z',
  frequency: 'Chattiest first',
  added: 'Date added',
};

// How often a persona speaks, most to least; the stored string sorts wrong
// alphabetically. Mirrors PERSONA_FREQUENCIES' order, and an unrecognised value
// sorts last so a hand-edited settings.json can't claim the top of the roster.
const FREQUENCY_RANK: Record<string, number> = {
  aggressive: 0, chatty: 1, moderate: 2, quiet: 3, silent: 4,
};
const frequencyRank = (p: Persona): number =>
  FREQUENCY_RANK[p.frequency] ?? Object.keys(FREQUENCY_RANK).length;

export interface PersonaRosterEntry {
  persona: Persona;
  // Position in the form array: RHF field paths, validation, deletion and
  // editing all key off this, never off display order.
  index: number;
  // 1-based position in the DISPLAYED roster; every human-facing counter
  // reads this.
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

// Display order only: callers keep `index` for RHF field paths, validation,
// deletion and editing. Reordering the form array itself would turn a navigation
// aid into a persisted settings change.
//
// The on-air persona pins to the top under every sort, but is pinned, not
// exempted: a filter that excludes it still excludes it.
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

      // 'added' is the form-array order, kept as an explicit choice.
      if (sort === 'added') return left.index - right.index;
      if (sort === 'frequency') {
        const byFreq = frequencyRank(left.persona) - frequencyRank(right.persona);
        if (byFreq) return byFreq;
      }
      return byName || left.index - right.index;
    })
    .map((entry, position) => ({ ...entry, position: position + 1 }));
}
