// Pure derivations for the durable transition seam record: the Stats page's
// Transitions card (GET /stats `transitions`) and the library History rows
// (GET /library/history `transition*`). The reason vocabulary and its labels
// come from the mirrored schema, so a code the controller stores is labelled
// the same way everywhere it is shown.

import { MIX_DROP_REASON_LABELS, type MixDropReason } from './schemas.generated';

export interface TransitionDrop {
  effect: string;
  reason: string;
  auto?: boolean;
}

export interface CountRow {
  label: string;
  count: number;
}

// 'sweep' → 'Sweep', 'normal' → 'Normal'. Matches the seam labels the controller
// writes ('Sweep', 'Loop', …), so an ask and the seam it became read alike.
export function effectLabel(kind: string): string {
  return kind ? kind.charAt(0).toUpperCase() + kind.slice(1) : kind;
}

// A stored code this build does not know (a newer controller) shows as itself
// rather than disappearing.
export function dropReasonLabel(code: string): string {
  return Object.prototype.hasOwnProperty.call(MIX_DROP_REASON_LABELS, code)
    ? MIX_DROP_REASON_LABELS[code as MixDropReason]
    : code;
}

// A count map as rows, largest first. Ties sort by label so the order holds
// still between polls. Zero, negative and non-numeric entries are dropped.
export function countRows(
  rec: Record<string, number | undefined> | null | undefined,
  label: (key: string) => string = k => k,
): CountRow[] {
  return Object.entries(rec ?? {})
    .filter((e): e is [string, number] => typeof e[1] === 'number' && e[1] > 0)
    .map(([k, n]) => ({ label: label(k), count: n }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

// Seams that carried an effect. Neither a plain crossfade ('Normal') nor a seam
// owned by something the mixer placed between the songs ('After jingle', 'After
// bed', 'After break') is one — the latter are the seams an effect could not ride.
export function effectSeamCount(bySeam: Record<string, number | undefined> | null | undefined): number {
  return Object.entries(bySeam ?? {})
    .filter(([label, n]) => label !== 'Normal' && !label.startsWith('After ') && typeof n === 'number' && n > 0)
    .reduce((sum, [, n]) => sum + (n as number), 0);
}

// One effect's drop reasons as a short line: "Pair did not suit it 8 · Repeat rule 2".
export function reasonSummary(rec: Record<string, number | undefined> | null | undefined): string {
  return countRows(rec, dropReasonLabel).map(r => `${r.label} ${r.count}`).join(' · ');
}

// "Sweep dropped: Pair did not suit it". `auto` marks the length-cap washout,
// which the controller armed itself rather than the DJ asking for it.
export function formatDrop(d: TransitionDrop): string {
  return `${effectLabel(d.effect)}${d.auto ? ' (auto)' : ''} dropped: ${dropReasonLabel(d.reason)}`;
}

// Every drop on a play, or null when there are none (including legacy rows,
// which carry no record at all).
export function formatDrops(drops: TransitionDrop[] | null | undefined): string | null {
  return drops?.length ? drops.map(formatDrop).join(' · ') : null;
}

export interface SeamRecord {
  transition?: string | null;
  transitionAsk?: string | null;
  transitionDrops?: TransitionDrop[] | null;
}

// The History row's one-line summary, or null when there is nothing worth a
// line: a legacy row (no record), or a plain crossfade with nothing dropped —
// the ordinary seam should leave an ordinary row. `title` is the full account
// for the hover, including the DJ's own ask.
export function historySeamLine(p: SeamRecord): { text: string; title: string } | null {
  const seam = p.transition && p.transition !== 'Normal' ? p.transition : null;
  const drops = formatDrops(p.transitionDrops);
  if (!seam && !drops) return null;
  // 'After jingle' / 'After bed' / 'After break': something the mixer placed
  // between the two songs owned the seam, so it reads as what came before.
  const after = seam?.startsWith('After ') ? seam.slice('After '.length).toLowerCase() : null;
  const seamText = !seam ? null : after ? `after a ${after}` : `in on ${seam}`;
  const text = [seamText, drops].filter(Boolean).join(' · ');
  const cameIn = p.transition == null ? null
    : p.transition === 'Normal' ? 'Came in on a plain crossfade'
    : after ? `Came in after a ${after}`
    : `Came in on: ${p.transition}`;
  const title = [
    cameIn,
    p.transitionAsk ? `DJ asked for: ${effectLabel(p.transitionAsk)}` : null,
    drops,
  ].filter(Boolean).join('\n');
  return { text, title };
}
