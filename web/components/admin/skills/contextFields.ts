import { CONTEXT_FIELDS, type ContextField } from '@/lib/schemas.generated';

// Human labels for the chips. Typed as an EXHAUSTIVE record, so adding a field
// to the controller's vocabulary fails the web build until it has a label
// rather than silently rendering a raw key.
export const CONTEXT_FIELD_LABELS: Record<ContextField, string> = {
  date: 'Date & season',
  clock: 'Clock time',
  time: 'Daypart',
  weather: 'Weather',
  festival: 'Festival',
  show: 'Current show',
  listeners: 'Listener count',
};

// Used when the controller doesn't send knownContextFields (an older
// controller, or a failed read) — the same list it would have sent.
export const CONTEXT_FIELDS_FALLBACK: string[] = [...CONTEXT_FIELDS];

export function splitContext(s?: string): string[] {
  return typeof s === 'string' ? s.split(',').map(t => t.trim()).filter(Boolean) : [];
}
