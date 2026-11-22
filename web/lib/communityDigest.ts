// The /community hub's view of the catalog: per-department counts, the newest
// additions across every kind, and a contributor roll call. Pure over the raw
// catalog.json lists (lib/communityCatalog.ts), so the page issues one fetch.
import type { CommunityCatalog } from './communityCatalog';

export type Kind = 'skill' | 'persona' | 'show' | 'app' | 'station';

export const KINDS: Kind[] = ['skill', 'persona', 'show', 'app', 'station'];

export interface WireItem {
  kind: Kind;
  name: string;
  href: string;
  by?: string;
  date: string;
}

export interface Contributor {
  handle: string;
  total: number;
  byKind: Record<Kind, number>;
}

export interface Digest {
  counts: Record<Kind, number>;
  previews: Record<Kind, string[]>;
  wire: WireItem[];
  contributors: Contributor[];
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

const HREF: Record<Kind, string> = {
  skill: '/skills',
  persona: '/personas',
  show: '/shows',
  app: '/apps',
  station: '/stations',
};

const ANCHOR: Partial<Record<Kind, string>> = {
  skill: 'skill-',
  persona: 'persona-',
  show: 'show-',
};

function nameOf(kind: Kind, e: Record<string, unknown>): string | undefined {
  if (kind === 'skill') return str(e.label) ?? str(e.slug);
  if (kind === 'persona') return str(e.displayName) ?? str(e.slug);
  return str(e.name) ?? str(e.slug);
}

function byOf(kind: Kind, e: Record<string, unknown>): string | undefined {
  const raw = kind === 'app' ? e.author : kind === 'station' ? e.operator : e.submittedBy;
  return str(raw)?.replace(/^@/, '');
}

function dateOf(kind: Kind, e: Record<string, unknown>): string | undefined {
  const d = kind === 'app' || kind === 'station' ? str(e.submitted) : str(e.dateAdded);
  return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : undefined;
}

function listOf(cat: CommunityCatalog, kind: Kind): Record<string, unknown>[] {
  return { skill: cat.skills, persona: cat.personas, show: cat.shows, app: cat.apps, station: cat.stations }[kind];
}

export function digest(cat: CommunityCatalog, wireSize = 10): Digest {
  const counts = {} as Record<Kind, number>;
  const previews = {} as Record<Kind, string[]>;
  const wire: WireItem[] = [];
  const people = new Map<string, Contributor>();

  for (const kind of KINDS) {
    const list = listOf(cat, kind);
    counts[kind] = list.length;
    previews[kind] = list
      .map((e) => nameOf(kind, e))
      .filter((n): n is string => Boolean(n))
      .slice(0, 4);

    for (const e of list) {
      const name = nameOf(kind, e);
      if (!name) continue;
      const by = byOf(kind, e);
      const date = dateOf(kind, e);
      const slug = str(e.slug);
      if (date) {
        const anchor = ANCHOR[kind];
        wire.push({
          kind,
          name,
          by,
          date,
          href: anchor && slug ? `${HREF[kind]}#${anchor}${slug}` : HREF[kind],
        });
      }
      if (by) {
        const key = by.toLowerCase();
        const c =
          people.get(key) ??
          ({ handle: by, total: 0, byKind: { skill: 0, persona: 0, show: 0, app: 0, station: 0 } } as Contributor);
        c.total += 1;
        c.byKind[kind] += 1;
        people.set(key, c);
      }
    }
  }

  wire.sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name));
  const contributors = [...people.values()].sort(
    (a, b) => b.total - a.total || a.handle.localeCompare(b.handle),
  );

  return { counts, previews, wire: wire.slice(0, wireSize), contributors };
}

export function kindHref(kind: Kind): string {
  return HREF[kind];
}
