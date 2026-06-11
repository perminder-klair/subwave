// SOURCE OF TRUTH: web/web/lib/tagline.ts — pure function, kept in sync.
import type { StationContext } from './types';

export function buildTagline(context: StationContext | null | undefined): string | null {
  if (!context) return null;
  const parts: string[] = [];

  if (context.festival?.name) {
    parts.push(context.festival.name.toLowerCase());
    if (context.festival.mood) parts.push(context.festival.mood);
  } else {
    if (context.time?.show) parts.push(context.time.show);
    if (context.time?.vibe && context.time.vibe !== context.time?.show) {
      parts.push(context.time.vibe);
    }
  }

  if (context.weather && context.weather.condition && context.weather.condition !== 'unknown') {
    const t = context.weather.temp;
    const cond = context.weather.condition;
    parts.push(Number.isFinite(t) ? `${t}° ${cond}` : cond);
  }

  return parts.length ? parts.join(' · ') : null;
}
