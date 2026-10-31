// A prepared takeover is an expiring draft, never a live schedule override.
// Only activation publishes its accepted plan and switches programming.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import * as settings from '../settings.js';
import { showSchema, SHOW_GENERATION_TEMPLATES, type Show } from '../schemas/show.js';
import { scheduleOverrideRequestSchema, type ScheduleOverride } from '../schemas/schedule.js';
import type { GeneratedShowPlan } from '../schemas/show-preparation.js';
import { diagnoseShowCandidates } from '../music/show-candidates.js';
import { BoundedKeyMap } from '../util/bounded-key-map.js';
import { resolveTakeoverWindowNow } from './takeover-window.js';
import { coverageUnavailable, ShowPlanningError, requiredShowArtists, artistCoverageError } from './show-planning-policy.js';
import {
  buildGeneratedSnapshot, generateAcceptedShowPlan, showPreparation,
  type GeneratedShowSnapshot,
} from './show-preparation.js';

export const takeoverPreviewRequestSchema = scheduleOverrideRequestSchema.safeExtend({
  template: z.enum(SHOW_GENERATION_TEMPLATES),
  expectedEndsAt: z.number().finite().optional(),
});
type Request = z.output<typeof takeoverPreviewRequestSchema>;
type Activated = { override: ScheduleOverride; shows: Show[] };
type Draft = {
  request: Request; show: Show; snapshot: GeneratedShowSnapshot; plan: GeneratedShowPlan;
  expiresAt: number; eligibility: string; activate?: Promise<Activated>;
};
const previews = new BoundedKeyMap<Draft>({ maxKeys: 32, isLive: (draft, now) => draft.expiresAt > now });

function templateShow(template: Request['template']): Show {
  const station = settings.get();
  if (!station.personas?.length) throw new Error('Add at least one DJ before preparing a Sub/Show takeover.');
  const id = `s_takeover_${template.replaceAll('-', '_')}`;
  const parsed = showSchema({
    personaIds: (station.personas ?? []).map(p => p.id), moodNames: settings.moodVocab(),
    themeIds: [], minTrackSeconds: settings.minTrackSeconds(),
  }).parse({
    id, name: template === 'dj-choice' ? "DJ's Choice" : template === 'common-ground' ? 'Common Ground' : template === 'outside-comfort-zone' ? 'Outside the Comfort Zone' : template === 'time-capsule' ? 'Time Capsule' : 'Deep Discovery',
    personaId: station.personas?.[0]?.id ?? '', programme: false,
    generation: {
      mode: 'generated', template, hostMode: 'random', guestMode: template === 'outside-comfort-zone' ? 'none' : 'random', guestCount: template === 'outside-comfort-zone' ? { min: 0, max: 0 } : template === 'common-ground' ? { min: 1, max: 1 } : { min: 0, max: 3 },
    },
  });
  return { ...parsed, id };
}

export async function prepareTakeoverPreview(request: Request) {
  await settings.load();
  await showPreparation.recover();
  const startsAt = Date.now();
  const endsAt = request.until === 'schedule-change'
    ? resolveTakeoverWindowNow(startsAt).expiresAt : startsAt + request.minutes! * 60_000;
  if (request.until === 'schedule-change' && request.expectedEndsAt != null && request.expectedEndsAt !== endsAt) {
    throw new Error('The schedule window changed. Retry to prepare the new window.');
  }
  const show = templateShow(request.template);
  const token = randomUUID();
  const snapshot = buildGeneratedSnapshot(show, {
    id: `takeover:${show.id}:${startsAt}`, showId: show.id, source: 'takeover', startsAt, endsAt,
  }, token);
  if (!snapshot) throw new Error(request.template === 'common-ground'
    ? 'Common Ground needs two distinct DJs enabled in Sub/Shows → Random Hosts.'
    : 'No eligible host is available for this Sub/Show. Check Sub/Shows settings.');
  const eligibility = JSON.stringify(settings.get().subShows);
  const plan = await generateAcceptedShowPlan(snapshot);
  const draft: Draft = { request, show, snapshot, plan, eligibility, expiresAt: Math.min(Date.now() + 15 * 60_000, request.until === 'schedule-change' ? endsAt : Infinity) };
  if (request.until === 'schedule-change' && Date.now() >= endsAt) {
    throw new Error('The schedule changed while generating. Retry to prepare the new window.');
  }
  previews.set(token, draft);
  const nameOf = (id: string) => settings.get().personas?.find(p => p.id === id)?.name ?? 'Unknown DJ';
  return {
    token, expiresAt: draft.expiresAt, plan,
    host: { id: snapshot.cast.hostPersonaId, name: nameOf(snapshot.cast.hostPersonaId) },
    guests: snapshot.cast.guestPersonaIds.map(id => ({ id, name: nameOf(id) })),
  };
}

export async function activateTakeoverPreview(token: string): Promise<Activated & { newlyActivated: boolean }> {
  const draft = previews.get(token);
  if (!draft || draft.expiresAt <= Date.now()) throw new Error('This preview expired or the controller restarted. Retry generation.');
  if (draft.activate) return { ...await draft.activate, newlyActivated: false };
  draft.activate = activate(draft).catch(error => { draft.activate = undefined; throw error; });
  return { ...await draft.activate, newlyActivated: true };
}

async function activate(draft: Draft): Promise<Activated> {
  await settings.load();
  const coverage = await diagnoseShowCandidates({ ...draft.show, ...draft.plan }, { at: Date.now(), showId: draft.show.id });
  if (coverageUnavailable(coverage.warnings)) {
    throw new ShowPlanningError('library-unavailable', `Could not verify the takeover's music filters. Check the library connection and genre metadata, then retry generation. ${coverage.warnings.join(' ')}`);
  }
  const requiredTracks = Math.ceil(2 * (draft.snapshot.occurrence.endsAt - draft.snapshot.occurrence.startsAt) / 240_000);
  if (coverage.library.effective < requiredTracks) throw new Error('The available music pool changed. Retry generation.');
  const artistSpacing = settings.get().llm.artistVarietyWindow;
  const requiredArtists = requiredShowArtists(requiredTracks, artistSpacing);
  if (coverage.artists < requiredArtists) throw artistCoverageError(requiredArtists, coverage.artists, artistSpacing);
  const current = buildGeneratedSnapshot(templateShow(draft.request.template), draft.snapshot.occurrence,
    draft.snapshot.castSeed, draft.snapshot.castOrigin);
  if (!current || current.configuration !== draft.snapshot.configuration
    || JSON.stringify(settings.get().subShows) !== draft.eligibility) {
    throw new Error('The DJ roster or Sub/Shows settings changed. Retry generation.');
  }
  const startedAt = Date.now();
  const expiresAt = draft.request.until === 'schedule-change'
    ? resolveTakeoverWindowNow(startedAt).expiresAt : startedAt + draft.request.minutes! * 60_000;
  if (draft.request.until === 'schedule-change' && expiresAt !== draft.snapshot.occurrence.endsAt) {
    throw new Error('The schedule window changed. Retry generation.');
  }
  const override = { showId: draft.show.id, startedAt, expiresAt };
  const occurrence = { id: `takeover:${draft.show.id}:${startedAt}`, showId: draft.show.id,
    source: 'takeover' as const, startsAt: startedAt, endsAt: expiresAt };
  const snapshot = buildGeneratedSnapshot(draft.show, occurrence, draft.snapshot.castSeed, draft.snapshot.castOrigin);
  if (!snapshot) throw new Error('The prepared cast is no longer available. Retry generation.');
  // Publish first: settings observers must see the prepared plan at the instant
  // the override becomes visible. A failed write leaves current programming on.
  await showPreparation.acceptPreparedGenerated(snapshot, draft.plan);
  try {
    const shows = settings.get().shows ?? [];
    const existing = shows.find(show => show.id === draft.show.id);
    if (existing && existing.generation?.mode !== 'generated') throw new Error('The takeover template id is already used by a regular show.');
    const found = !!existing;
    if (!found && shows.length >= settings.SHOWS_LIMIT) throw new Error('The show list is full. Remove a show before starting this takeover.');
    await settings.update({
      shows: found ? shows.map(show => show.id === draft.show.id ? draft.show : show) : [...shows, draft.show],
      scheduleOverride: override,
    });
  } catch (error) {
    await showPreparation.discardPreparedGenerated(occurrence.id);
    throw error;
  }
  return { override, shows: settings.get().shows ?? [] };
}
