// Read-only schedule facts for skill tools. No show generation or schedule writes.
import { createHash } from 'node:crypto';
import * as settings from '../settings.js';
import { zonedISODate, zonedParts } from '../time.js';
import { resolveShowOccurrence } from '../broadcast/show-occurrence.js';
import { generatedShowAt } from '../broadcast/generated-show-registry.js';

function todayProgramming(at = Date.now()) {
  const station = settings.get();
  const day = zonedISODate(new Date(at));
  const override = settings.getScheduleOverride();
  const shadowUntil = override && override.startedAt <= at && override.expiresAt > at ? override.expiresAt : at;
  const seen = new Set<string>();
  const shows: Array<{
    occurrenceId: string; startsAt: number; endsAt: number; startTime: string;
    title: string; brief: string; ready: boolean;
    host: { id: string; name: string } | null; guests: Array<{ id: string; name: string }>;
  }> = [];
  const persona = (id: string) => {
    const p = station.personas?.find(p => p.id === id);
    return p ? { id: p.id, name: p.name } : null;
  };
  for (let cursor = Math.floor(at / 60_000) * 60_000; cursor < at + 26 * 3_600_000;) {
    if (zonedISODate(new Date(cursor)) !== day) break;
    const p = zonedParts(new Date(cursor));
    const id = station.schedule?.[p.dow]?.[p.hour];
    const show = id ? station.shows?.find(show => show.id === id) : null;
    if (!show) { cursor += 60_000; continue; }
    const occurrence = resolveShowOccurrence({ at: cursor, showId: show.id, schedule: station.schedule,
      override: null, parts: ms => zonedParts(new Date(ms)) });
    if (!occurrence) { cursor += 60_000; continue; }
    cursor = Math.max(cursor + 60_000, occurrence.endsAt);
    const startsAt = Math.max(occurrence.startsAt, shadowUntil);
    if (seen.has(occurrence.id) || startsAt <= at || startsAt >= occurrence.endsAt
      || zonedISODate(new Date(startsAt)) !== day) continue;
    seen.add(occurrence.id);
    const generated = show.generation?.mode === 'generated';
    const record = generated ? generatedShowAt(show.id, occurrence.startsAt, 'scheduled', occurrence.startsAt) : null;
    const ready = !generated || (record?.kind === 'ready' && record.occurrence.endsAt === occurrence.endsAt);
    const plan = ready && record?.kind === 'ready' ? record.plan : null;
    const host = persona(ready && record?.kind === 'ready' ? record.hostPersonaId : show.personaId);
    const guestIds = ready && record?.kind === 'ready' ? record.guestPersonaIds : show.guestPersonaIds;
    const startTime = new Intl.DateTimeFormat('en-US', {
      timeZone: station.timezone || undefined, hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(new Date(startsAt)).replace(':00', '').replace(/\s/g, '').toLowerCase();
    shows.push({
      occurrenceId: occurrence.id, startsAt, endsAt: occurrence.endsAt,
      startTime,
      title: plan?.name ?? show.name, brief: (plan?.topic ?? show.topic ?? '').slice(0, 2000),
      ready: ready && !!host, host,
      guests: (guestIds ?? []).map(persona).filter((p): p is NonNullable<typeof p> => !!p),
    });
  }
  const nextOccurrenceId = shows[0]?.occurrenceId ?? null;
  const stamp = createHash('sha256').update(JSON.stringify({ day, nextOccurrenceId, shows })).digest('hex');
  return { day, nextOccurrenceId, shows, stamp };
}

export function laterTodayProgramming(speakerPersonaId: string | null = null) {
  const snapshot = todayProgramming();
  const station = settings.get();
  const speaker = speakerPersonaId ? station.personas?.find(p => p.id === speakerPersonaId) : null;
  return {
    day: snapshot.day, timezone: station.timezone, lookAheadStamp: snapshot.stamp,
    speaker: speaker ? { id: speaker.id, name: speaker.name } : null,
    shows: snapshot.shows.filter(show => show.ready && show.occurrenceId !== snapshot.nextOccurrenceId)
      .map(show => ({ ...show, speakerRole: !speaker ? 'unknown'
        : show.host?.id === speaker.id ? 'host'
          : show.guests.some(guest => guest.id === speaker.id) ? 'guest' : 'neither' })),
  };
}

// Keep grounding beside each run, not in a station-wide last-tool-result slot.
const sources = new WeakMap<object, Map<string, Set<string>>>();
export function rememberLookAheadSource(context: object, kind: string, data: unknown): void {
  const stamp = data && typeof data === 'object' && 'lookAheadStamp' in data ? data.lookAheadStamp : null;
  if (typeof stamp !== 'string' || !/^[a-f0-9]{64}$/.test(stamp)) return;
  let byKind = sources.get(context);
  if (!byKind) { byKind = new Map(); sources.set(context, byKind); }
  let stamps = byKind.get(kind);
  if (!stamps) { stamps = new Set(); byKind.set(kind, stamps); }
  stamps.add(stamp);
}
export function lookAheadSourceMeta(context: object, kind: string) {
  const stamps = sources.get(context)?.get(kind);
  return stamps?.size ? { lookAheadStamps: [...stamps] } : {};
}
export function lookAheadStampsCurrent(stamps: unknown): boolean {
  if (stamps === undefined) return true;
  if (!Array.isArray(stamps) || !stamps.length || stamps.some(stamp => typeof stamp !== 'string')) return false;
  const current = todayProgramming().stamp;
  return stamps.every(stamp => stamp === current);
}

// Keep each spoken time/title/cast together; the model writes only the description.
export function renderLookAheadTeases(data: {
  mode: string; speaker: { id: string; name: string };
  shows: Array<{ startTime: string; title: string; host: { id: string; name: string };
    guests: Array<{ id: string; name: string }> }>;
}, firstSummary: string, secondSummary: string): string {
  if (!data.shows?.length || data.shows.length > 2 || (data.mode === 'upcoming-host-promo' && data.shows.length !== 1)) {
    throw new Error('invalid Look Ahead show count');
  }
  const list = (names: string[]) => names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  const summaries = [firstSummary, secondSummary];
  const first = (name: string) => name.trim().split(/\s+/)[0] || name;
  const pieces = data.shows.map((show, index) => {
    const candidate = summaries[index].trim();
    // Keep the controller-authored link if the model summary adds timing; drop only that summary.
    const summary = /\b(?:\d{1,2}[:.]\d{2}|\d{1,2}\s*(?:a\.?m\.?|p\.?m\.?)|today|tomorrow|tonight|this morning|this afternoon|this evening|later still)\b/i.test(candidate)
      ? '' : candidate;
    const ownShow = show.host.id === data.speaker.id;
    const colleagues = [show.host, ...show.guests].filter(person => person.id !== data.speaker.id).map(person => first(person.name));
    const presenters = [show.host, ...show.guests].map(person => first(person.name));
    const lead = ownShow
      ? `I'm back at ${show.startTime}${colleagues.length ? ` with ${list(colleagues)}` : ''} for “${show.title}”.`
      : show.guests.some(guest => guest.id === data.speaker.id)
        ? `I'm joining ${list(colleagues)} at ${show.startTime} for “${show.title}”.`
        : `Catch ${list(presenters)} at ${show.startTime} for “${show.title}”.`;
    return `${lead}${summary ? ` ${summary}` : ''}`;
  });
  const firstName = first(data.speaker.name);
  return `${data.mode === 'upcoming-host-promo' ? `Hi, ${firstName} here. ` : ''}${pieces.join(' ')}`;
}
