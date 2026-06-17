export function fmtTime(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return '–:––';
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

// Wall-clock time-of-day for an on-air event, rendered in the station's zone.
// The DJ speaks the time in the configured station timezone (controller's
// time.ts), so log/booth timestamps must use that same zone — otherwise an
// operator or listener viewing from a different timezone sees stamps that
// disagree with what the DJ just said (issue #418). `tz` is the IANA zone from
// /now-playing | /state | /debug; falls back to the browser's local zone when
// it's absent. Returns '' for a missing timestamp so callers can `|| '—'`.
export function fmtClock(t: string | number | null | undefined, tz?: string | null): string {
  if (t == null) return '';
  try {
    return new Date(t).toLocaleTimeString('en-GB', {
      hour12: false,
      ...(tz ? { timeZone: tz } : {}),
    });
  } catch {
    return String(t);
  }
}

const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Day-of-week (0=Sun, matching Date.getDay()) and hour (0-23) for `date` as it
// reads on the wall clock in `tz`. Mirrors the controller's zonedParts so the
// schedule grid's "now" marker lands on the same cell the controller resolves
// the active show from — without this the highlight follows the operator's own
// browser zone, not the station's (issue #418). Falls back to the local zone
// when `tz` is absent.
export function zonedDayHour(date: Date, tz?: string | null): { dow: number; hour: number } {
  if (!tz) return { dow: date.getDay(), hour: date.getHours() };
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      weekday: 'short',
      hour: 'numeric',
      hour12: false,
    }).formatToParts(date);
    const out: Record<string, string> = {};
    for (const p of parts) out[p.type] = p.value;
    // en-GB with hour12:false can render midnight as "24" — normalise.
    return { dow: DOW[out.weekday ?? ''] ?? date.getDay(), hour: Number(out.hour) % 24 };
  } catch {
    return { dow: date.getDay(), hour: date.getHours() };
  }
}

export function relTime(t: string | number | Date): string {
  const diff = (Date.now() - new Date(t).getTime()) / 1000;
  if (diff < 60) return `${Math.max(1, Math.floor(diff))}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

export function fmtSize(n: number | null | undefined): string {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
