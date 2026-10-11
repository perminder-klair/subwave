// Facet planner for the acoustic-analysis pass: which tracks get which facets,
// read from track_facet_status (library-db/facets.ts). Pure — the caller loads
// the facet rows and capabilities, so the decisions are unit-pinned in
// scripts/acoustics-plan.test.ts and printable as a dry run.
//
// The worker protocol is still the flat one (one request computes everything a
// track's flags allow), so a work item is translated into today's request
// flags: a CLAP-only item takes the embedding-only fast path, an item without
// clap/vocal/stems turns those models OFF for that track, and anything else is
// a full analysis. Per-facet worker requests come with the protocol change.

import {
  FACETS,
  FACET_VERSIONS,
  type Facet,
  type FacetCell,
} from './library-db/facets.js';
import { analysisRetryAllowed, tailVocalBackfillAvailable } from './analyze-capability.js';

export type { FacetCell };

// One track's stored facet rows (absent facet = never attempted).
export type TrackFacets = ReadonlyMap<Facet, FacetCell>;

// Which stored state a facet must be in for the track to be selected.
//   needs         never attempted, outdated version, or failed < max attempts
//                 (what the normal pass would pick up)
//   missing       never attempted
//   unmeasurable  attempted and not measurable at this version (optionally
//                 only rows whose reason contains `reason`)
//   failed        a failed pass, including a kept measurement and exhausted
//                 retries (explicit retry)
//   outdated      measured by an older facet version, under the retry limit
//   all           every track in scope (force a redo)
export type WhereKind = 'needs' | 'missing' | 'unmeasurable' | 'failed' | 'outdated' | 'all';
export const WHERE_KINDS: readonly WhereKind[] = ['needs', 'missing', 'unmeasurable', 'failed', 'outdated', 'all'];

export interface Where {
  kind: WhereKind;
  reason?: string;
}

export interface PlanCapabilities {
  // null = unknown (analyzer not probed / too old to say): planned, flagged.
  clap: boolean | null;
  demucs: boolean | null;
  // Tail-only vocal backfill requires positive support, unlike missing heads.
  tailVocal: boolean | null;
}

export interface PlanInput {
  ids: readonly string[];
  facets: readonly Facet[];
  where: Where;
  state: ReadonlyMap<string, TrackFacets>;
  capabilities: PlanCapabilities;
  limit?: number;
}

// The worker flags one track's facets translate to.
export interface WorkRequest {
  embeddingOnly: boolean; // clap alone: skip every CPU feature
  clap: boolean;
  vocal: boolean;
  stems: boolean;
}

export interface WorkItem {
  id: string;
  facets: Facet[];
  request: WorkRequest;
}

export type SkipReason = 'no-clap' | 'no-demucs' | 'no-tail-vocal' | 'limit';

export interface FacetPlanCount {
  facet: Facet;
  matched: number;
  planned: number;
  skipped: Partial<Record<SkipReason, number>>;
}

export interface AcousticsPlan {
  where: Where;
  facets: Facet[];
  inScope: number;
  items: WorkItem[];
  byFacet: FacetPlanCount[];
  // Facets that ride along on a full analysis without being asked for (the
  // flat protocol recomputes them). Shown in the dry run so nothing is hidden.
  rideAlong: Facet[];
  warnings: string[];
}

export function matchesWhere(cell: FacetCell | undefined, facet: Facet, where: Where): boolean {
  const current = FACET_VERSIONS[facet];
  switch (where.kind) {
    case 'all':
      return true;
    case 'missing':
      return !cell;
    case 'outdated':
      return !!cell && analysisRetryAllowed(cell.attempts) && cell.version < current;
    case 'failed':
      return !!cell && cell.attempts > 0;
    case 'unmeasurable':
      return analysisRetryAllowed(cell?.attempts ?? 0) && (
        !!cell &&
        cell.status === 'unmeasurable' &&
        (!where.reason || (cell.reason ?? '').toLowerCase().includes(where.reason.toLowerCase()))
      );
    case 'needs':
    default:
      return analysisRetryAllowed(cell?.attempts ?? 0) && (
        !cell ||
        cell.version < current ||
        cell.status === 'failed'
      );
  }
}

const FULL_PASS: readonly Facet[] = ['head', 'loudness', 'tail'];

export function requestFor(facets: readonly Facet[]): WorkRequest {
  const has = (f: Facet) => facets.includes(f);
  const clap = has('clap');
  const vocal = has('vocal');
  const stems = has('stems');
  return {
    embeddingOnly: clap && !vocal && !stems && !FULL_PASS.some(has),
    clap,
    vocal,
    stems,
  };
}

export function planAcoustics(input: PlanInput): AcousticsPlan {
  const facets = FACETS.filter((f) => input.facets.includes(f));
  const counts = new Map<Facet, FacetPlanCount>(
    facets.map((f) => [f, { facet: f, matched: 0, planned: 0, skipped: {} }]),
  );
  const skip = (f: Facet, why: SkipReason) => {
    const c = counts.get(f)!;
    c.skipped[why] = (c.skipped[why] ?? 0) + 1;
  };
  const unavailable = (f: Facet, cell: FacetCell | undefined): SkipReason | null => {
    if (f === 'clap' && input.capabilities.clap === false) return 'no-clap';
    if ((f === 'vocal' || f === 'stems') && input.capabilities.demucs === false) return 'no-demucs';
    if (f === 'vocal' && cell?.reason === 'head-only' &&
      !tailVocalBackfillAvailable(input.capabilities.tailVocal)) return 'no-tail-vocal';
    return null;
  };

  const items: WorkItem[] = [];
  const limit = input.limit && input.limit > 0 ? Math.floor(input.limit) : Infinity;
  const empty: TrackFacets = new Map();
  for (const id of input.ids) {
    const state = input.state.get(id) ?? empty;
    const picked: Facet[] = [];
    for (const f of facets) {
      if (!matchesWhere(state.get(f), f, input.where)) continue;
      counts.get(f)!.matched += 1;
      const why = unavailable(f, state.get(f));
      if (why) {
        skip(f, why);
        continue;
      }
      picked.push(f);
    }
    if (picked.length === 0) continue;
    if (items.length >= limit) {
      for (const f of picked) skip(f, 'limit');
      continue;
    }
    for (const f of picked) counts.get(f)!.planned += 1;
    items.push({ id, facets: picked, request: requestFor(picked) });
  }

  // A full analysis recomputes head/loudness/tail whatever was asked: say so.
  const anyFull = items.some((i) => !i.request.embeddingOnly);
  const rideAlong = anyFull ? FULL_PASS.filter((f) => !facets.includes(f)) : [];

  const warnings: string[] = [];
  if (facets.includes('clap') && input.capabilities.clap === null) {
    warnings.push('CLAP capability unknown (analyzer not probed) — clap items are planned but may produce no vector');
  }
  if ((facets.includes('vocal') || facets.includes('stems')) && input.capabilities.demucs === null) {
    warnings.push('Demucs capability unknown (analyzer not probed) — vocal/stems items are planned but may be no-ops');
  }
  if (facets.includes('tail')) {
    warnings.push(
      'tail: the analyzer still reads a byte-capped download, so a large file can come back unmeasurable again (ranged fetch is a later change)',
    );
  }
  if (facets.includes('stems')) {
    warnings.push('stems: the stem-cache byte budget is enforced at run time, so fewer than planned may be written');
  }

  return {
    where: input.where,
    facets,
    inScope: input.ids.length,
    items,
    byFacet: facets.map((f) => counts.get(f)!),
    rideAlong,
    warnings,
  };
}

// Parse `--facets tail,clap`. Throws on an unknown facet name.
export function parseFacets(spec: string): Facet[] {
  const names = spec.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (names.length === 0) throw new Error('--facets needs at least one facet');
  for (const n of names) {
    if (!(FACETS as readonly string[]).includes(n)) {
      throw new Error(`unknown facet "${n}" (known: ${FACETS.join(', ')})`);
    }
  }
  return FACETS.filter((f) => names.includes(f));
}

// Parse `--where unmeasurable:capped` / `--where failed`. Default: needs.
export function parseWhere(spec: string | undefined): Where {
  if (!spec) return { kind: 'needs' };
  const [kind, ...rest] = spec.split(':');
  const k = kind.trim().toLowerCase() as WhereKind;
  if (!WHERE_KINDS.includes(k)) {
    throw new Error(`unknown --where "${kind}" (known: ${WHERE_KINDS.join(', ')})`);
  }
  const reason = rest.join(':').trim();
  if (reason && k !== 'unmeasurable') throw new Error('a :reason filter only applies to --where unmeasurable');
  return reason ? { kind: k, reason } : { kind: k };
}

// Human summary for --dry-run and the pass log.
export function formatPlan(plan: AcousticsPlan, sample = 10): string[] {
  const out: string[] = [];
  const where = plan.where.kind + (plan.where.reason ? `:${plan.where.reason}` : '');
  out.push(`plan: facets ${plan.facets.join(',')} where ${where} — ${plan.items.length} of ${plan.inScope} tracks in scope`);
  out.push(`  facet      matched  planned  skipped`);
  for (const c of plan.byFacet) {
    const skipped = Object.entries(c.skipped).map(([k, v]) => `${k} ${v}`).join(', ') || '-';
    out.push(`  ${c.facet.padEnd(9)} ${String(c.matched).padStart(8)} ${String(c.planned).padStart(8)}  ${skipped}`);
  }
  const embedOnly = plan.items.filter((i) => i.request.embeddingOnly).length;
  out.push(`  worker requests: ${plan.items.length - embedOnly} full analysis, ${embedOnly} CLAP-only`);
  if (plan.rideAlong.length) {
    out.push(`  note: a full analysis also recomputes ${plan.rideAlong.join(', ')} (one worker call per track)`);
  }
  for (const w of plan.warnings) out.push(`  note: ${w}`);
  if (plan.items.length) {
    out.push(`  first ${Math.min(sample, plan.items.length)}: ` +
      plan.items.slice(0, sample).map((i) => `${i.id}[${i.facets.join('+')}]`).join(' '));
  }
  return out;
}
