// What a Dash Requests row says about one request, kept out of the component so
// it is tested on its own.
import { fmtClockMinute } from '../../../lib/format';
import type { StationLocale } from '../../../lib/types';

// routes/request.ts writes `path` (which route answered) and `pickSource` (how
// that route chose). They often say the same thing ("agent" and "agent"), so
// the row shows the route once, in words, and the choice only when it adds
// something: "agent:off-topic" under the agent reads "off-topic".
const PATH_LABELS: Record<string, string> = {
  agent: 'DJ agent',
  cascade: 'rules',
  chat: 'chat',
  'more-like-this': 'more like this',
};

export function requestHow(path: string | null | undefined, pickSource: string | null | undefined): {
  route: string | null;
  detail: string | null;
} {
  const route = path ? (PATH_LABELS[path] ?? path) : null;
  let detail = pickSource?.trim() || null;
  if (detail && path) {
    if (detail === path) detail = null;
    else if (detail.startsWith(`${path}:`)) detail = detail.slice(path.length + 1) || null;
  }
  // A chat the agent answered.
  if (path === 'chat' && detail === 'agent-chat') detail = 'answered by the agent';
  if (!route && detail) return { route: detail, detail: null };
  return { route, detail };
}

// How long the request took to answer, from `ms`.
export function fmtTook(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const whole = Math.round(s);
  return `${Math.floor(whole / 60)} min ${String(whole % 60).padStart(2, '0')} s`;
}

// When it was asked, on the station's clock: "Thu 19 Nov · 08:30". The day is
// there because the list reaches back several days.
export function fmtRequestWhen(
  t: string | number | null | undefined,
  tz?: string | null,
  locale?: StationLocale | null,
): string {
  if (t == null) return '';
  const date = new Date(t);
  if (Number.isNaN(date.getTime())) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      weekday: 'short', day: 'numeric', month: 'short',
      ...(tz ? { timeZone: tz } : {}),
    }).formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)?.value ?? '';
    return `${part('weekday')} ${part('day')} ${part('month')} · ${fmtClockMinute(date, tz, locale)}`;
  } catch {
    return '';
  }
}
