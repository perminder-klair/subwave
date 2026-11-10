import type { DebugIcecast } from './types';

export function oneLine(s: unknown, n = 110): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

// Ring entries store structured output as compact JSON. Free text and truncated
// JSON (older entries capped mid-string) fall through unchanged.
export function prettyMaybeJson(s: string): string {
  const t = s.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return s;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return s;
  }
}

export function fmtListeners(icecast: DebugIcecast | undefined): string {
  if (!icecast || icecast.error) return '—';
  if (icecast.listeners != null) return `${icecast.listeners} listeners`;
  return 'up';
}

export function fmtListenerPeak(icecast: DebugIcecast | undefined): string {
  if (!icecast || icecast.error || icecast.listener_peak == null) return '—';
  return `sum of mount peaks ${icecast.listener_peak}`;
}

export function kindTone(k?: string): string {
  switch (k) {
    case 'error':
    case 'miss':
      return 'danger';
    case 'queued':
    case 'scheduler':
      return 'muted';
    default:
      return 'accent';
  }
}

