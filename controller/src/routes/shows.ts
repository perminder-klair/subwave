// Admin show routes: per-show upsert/delete, the weekly grid, timed takeovers,
// and the one-tap community install. Reading shows still travels inside
// GET/POST /settings, and settings.update() stays the validation chokepoint.

import express from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import * as settings from '../settings.js';
import { requireAdmin } from '../middleware/auth.js';
import { validateBody, validateBodyAsync } from '../middleware/validate.js';
import {
  isDefaultTakeover,
  resolveScheduleSlots,
  scheduleOverrideRequestSchema,
  scheduleSaveSchema,
  takeoverShowId,
} from '../schemas/schedule.js';
import { showPostSchema } from '../schemas/show.js';
import { listThemes } from '../themes.js';
import { readCommunityShow } from '../shows/community.js';
import { SLUG_RE } from '../skills/loader.js';
import { queue } from '../broadcast/queue.js';
import { rollSessionNow } from '../broadcast/scheduler.js';
import { GeneratedShowRegenerationError, prepareUpcomingGeneratedShows, showPreparation } from '../broadcast/show-preparation.js';
import { activateTakeoverPreview, prepareTakeoverPreview, takeoverPreviewRequestSchema } from '../broadcast/takeover-generation.js';
import { resolveTakeoverWindowNow } from '../broadcast/takeover-window.js';
import { diagnoseShowCandidates } from '../music/show-candidates.js';
import { isInOrderShow } from '../music/playlist-order.js';
import { playlistCursors, resolveInOrderNext } from '../music/playlist-order-next.js';

export const router = express.Router();

// The show schema is a factory over live state, the same four inputs update()
// assembles for validateShowsStrict. Built per request so a persona added
// seconds ago is a legal host immediately.
async function showPostContext() {
  await settings.load();
  const s = settings.get();
  return showPostSchema({
    personaIds: (s.personas || []).map((p: { id: string }) => p.id),
    moodNames: (s.moods || []).map((m: { name: string }) => m.name),
    themeIds: (await listThemes()).map((t: { id: string }) => t.id),
    minTrackSeconds: settings.minTrackSeconds(),
  });
}

// Read-only: accepts the editor draft but never persists or schedules it.
router.post('/shows/candidates', requireAdmin, validateBodyAsync(showPostContext), async (req, res) => {
  try { res.json(await diagnoseShowCandidates(req.body.show)); }
  catch (err: any) { queue.log('error', 'POST /shows/candidates failed: ' + err.message); res.status(500).json({ error: err.message }); }
});

// A stable new identity makes saving an episode idempotent without altering it.
const savedEpisodeId = (id: string) => `s_episode_${createHash('sha256').update(id).digest('hex').slice(0, 20)}`;
const occurrenceBody = z.object({ occurrenceId: z.string().min(1).max(200) });
const pendingEpisodeSaves = new Map<string, Promise<unknown>>();

router.post('/shows/generated/save-draft', requireAdmin, validateBody(occurrenceBody), async (req, res) => {
  try {
    await settings.load();
    const record = (await showPreparation.generatedRecords()).find(r => r.occurrence.id === req.body.occurrenceId);
    if (!record || record.kind !== 'ready') return res.status(404).json({ error: 'This episode has no accepted plan to save.' });
    const id = savedEpisodeId(record.occurrence.id);
    const existing = settings.get().shows?.find(show => show.id === id);
    const source = settings.get().shows?.find(show => show.id === record.occurrence.showId);
    // These immutable inputs were recorded with the plan, including playlist
    // restrictions; do not substitute later edits to the recurring slot.
    const inputs = record.configuration ? JSON.parse(record.configuration) : null;
    // Older past records intentionally discarded their fingerprint. Preserve
    // non-sensitive source settings separately for new episodes; legacy ones
    // can only fall back to the surviving recurring show.
    const sourceSettings = record.sourceSettings ?? (inputs ? {
      playlistIds: inputs[7] ?? [], playlistStrict: inputs[8] ?? false,
      excludedPlaylistIds: inputs[9] ?? [], maxTrackSeconds: inputs[10] ?? null,
      minTrackLengthSeconds: inputs[11] ?? null, vocals: inputs[12] ?? '',
    } : {});
    const show = existing ?? {
      ...source, ...record.plan, id,
      personaId: record.hostPersonaId, guestPersonaIds: record.guestPersonaIds,
      generation: undefined, programme: false, preparationSkill: '', segmentSkill: '',
      ...sourceSettings,
    };
    res.json({ show, saved: !!existing, generatedAt: record.generatedAt });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/shows/generated/save', requireAdmin, validateBodyAsync(async () =>
  (await showPostContext()).extend({ occurrenceId: occurrenceBody.shape.occurrenceId, generatedAt: z.number().finite() })
), async (req, res) => {
  const id = savedEpisodeId(req.body.occurrenceId);
  try {
    const save = async () => {
      await settings.load();
      const shows = settings.get().shows ?? [];
      const existing = shows.find(show => show.id === id);
      if (existing) return { show: existing, shows };
      const record = (await showPreparation.generatedRecords()).find(r => r.occurrence.id === req.body.occurrenceId);
      if (!record || record.kind !== 'ready' || record.generatedAt !== req.body.generatedAt) {
        throw new GeneratedShowRegenerationError('The episode changed. Close and reopen Save before trying again.', 'conflict');
      }
      if (req.body.show.id !== id || req.body.show.generation?.mode === 'generated') {
        throw new GeneratedShowRegenerationError('Save requires a new regular show.', 'conflict');
      }
      if (shows.length >= settings.SHOWS_LIMIT) throw new GeneratedShowRegenerationError('The show list is full. Remove a show first.', 'conflict');
      await settings.update({ shows: [...shows, req.body.show] });
      const next = settings.get().shows ?? [];
      return { show: next.find(show => show.id === id), shows: next };
    };
    let operation = pendingEpisodeSaves.get(id);
    if (!operation) {
      operation = save().finally(() => pendingEpisodeSaves.delete(id));
      pendingEpisodeSaves.set(id, operation);
    }
    res.json(await operation);
  } catch (err: any) { res.status(err instanceof GeneratedShowRegenerationError ? 409 : 400).json({ error: err.message }); }
});

router.post('/shows/generated/shuffle', requireAdmin, validateBody(occurrenceBody), async (req, res) => {
  try {
    await settings.load();
    const record = (await showPreparation.generatedRecords()).find(r => r.occurrence.id === req.body.occurrenceId);
    if (!record) return res.status(404).json({ error: 'This episode is no longer available.' });
    const show = settings.get().shows?.find(show => show.id === record.occurrence.showId);
    if (show?.generation?.hostMode !== 'random' && show?.generation?.guestMode !== 'random') {
      return res.status(409).json({ error: 'This slot has no random host or guest options.' });
    }
    for (let attempt = 0; attempt < 20; attempt++) {
      const castSeed = randomUUID();
      const cast = await showPreparation.previewGeneratedCast(req.body.occurrenceId, castSeed);
      if (cast.hostPersonaId !== record.hostPersonaId || [...cast.guestPersonaIds].sort().join(',') !== [...record.guestPersonaIds].sort().join(',')) {
        return res.json({ castSeed, ...cast });
      }
    }
    res.status(409).json({ error: 'No different cast was found in the eligible pools. Adjust the host or guest options and try again.' });
  } catch (err: any) { res.status(err instanceof GeneratedShowRegenerationError && err.code === 'not-found' ? 404 : 409).json({ error: err.message }); }
});

// Dashboard programming choices need template identity, not persona prompts.
router.get('/shows/takeover', requireAdmin, async (_req, res) => {
  try {
    await settings.load();
    const active = settings.resolveActiveShow();
    res.json({
      shows: (settings.get().shows ?? []).map(show => ({
        id: show.id, name: active && active.id === show.id ? active.name : show.name,
        ...(show.generation ? { generation: { mode: show.generation.mode, template: show.generation.template } } : {}),
      })),
      override: settings.getScheduleOverride(),
    });
  } catch (err: unknown) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }); }
});

// Generated episode history deliberately omits the saved configuration string,
// which carries persona prompt material used to decide the plan.
router.get('/shows/generated', requireAdmin, async (req, res) => {
  try {
    await settings.load();
    const requested = Number.parseInt(String(req.query.limit ?? ''), 10);
    const limit = Number.isFinite(requested) ? Math.min(100, Math.max(1, requested)) : 50;
    const episodes = (await showPreparation.generatedRecords()).slice(0, limit).map(record => ({
      occurrence: record.occurrence,
      template: record.template,
      hostPersonaId: record.hostPersonaId,
      guestPersonaIds: record.guestPersonaIds,
      status: record.kind,
      savedShowId: settings.get().shows?.some(show => show.id === savedEpisodeId(record.occurrence.id)) ? savedEpisodeId(record.occurrence.id) : null,
      canShuffle: settings.get().shows?.some(show => show.id === record.occurrence.showId
        && (show.generation?.hostMode === 'random' || show.generation?.guestMode === 'random')) ?? false,
      ...(record.kind === 'ready'
        ? { plan: record.plan, generatedAt: record.generatedAt }
        : { reason: record.reason, attempts: record.attempts }),
    }));
    res.json({ episodes });
  } catch (err: any) {
    queue.log('error', `GET /shows/generated failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/shows/generated/regenerate', requireAdmin, validateBody(z.object({
  occurrenceId: z.string().min(1).max(200),
  castSeed: z.string().uuid().optional(),
  cast: z.object({ hostPersonaId: z.string(), guestPersonaIds: z.array(z.string()).max(3) }).optional(),
})), async (req, res) => {
  try {
    await settings.load();
    if (req.body.castSeed) {
      const cast = await showPreparation.previewGeneratedCast(req.body.occurrenceId, req.body.castSeed);
      if (!req.body.cast || cast.hostPersonaId !== req.body.cast.hostPersonaId
        || JSON.stringify(cast.guestPersonaIds) !== JSON.stringify(req.body.cast.guestPersonaIds)) {
        return res.status(409).json({ error: 'Casting options changed. Shuffle again to preview the current cast.' });
      }
    }
    const record = await showPreparation.regenerateGenerated(req.body.occurrenceId, req.body.castSeed);
    if (!record) return res.status(409).json({ error: 'The slot started or changed while generating. Refresh the episode list.' });
    if (record.kind === 'failed') return res.status(502).json({ error: record.reason });
    res.json({ ok: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof GeneratedShowRegenerationError
      ? err.code === 'not-found' ? 404 : 409
      : 502;
    queue.log('error', `POST /shows/generated/regenerate failed: ${message}`);
    res.status(status).json({ error: message });
  }
});

router.post('/shows/community/:slug/install', requireAdmin, async (req, res) => {
  const slug = String(req.params.slug);
  if (!SLUG_RE.test(slug)) {
    return res.status(400).json({ error: `invalid show slug: ${slug}` });
  }

  const cs = await readCommunityShow(slug);
  if (!cs) {
    return res.status(404).json({ error: `no such community show: ${slug}` });
  }

  await settings.load();
  const s = settings.get();
  const shows = s.shows || [];
  if (shows.length >= settings.SHOWS_LIMIT) {
    return res.status(409).json({ error: `the show list is full (${settings.SHOWS_LIMIT} shows max) — remove one first` });
  }
  const wanted = cs.name.trim().toLowerCase();
  if (shows.some((sh: any) => String(sh.name).trim().toLowerCase() === wanted)) {
    return res.status(409).json({ error: `a show named "${cs.name}" already exists` });
  }

  // Host defaults to the active persona; the operator reassigns it later. With
  // no id supplied validateShowsStrict mints the s_ id. Not placed in the grid.
  const personaId = s.activePersonaId || s.personas?.[0]?.id;
  if (!personaId) {
    return res.status(409).json({ error: 'no persona in the roster to host the show — add a persona first' });
  }
  const show = {
    name: cs.name,
    topic: cs.topic,
    personaId,
    guestPersonaIds: [],
    banter: cs.banter,
    programme: cs.programme,
    segmentSkill: cs.segmentSkill,
    preparationSkill: cs.preparationSkill,
    moods: cs.moods,
    themeId: '',
    genres: cs.genres,
    eras: cs.eras,
    energies: cs.energies,
    vocals: cs.vocals,
    filtersStrict: cs.filtersStrict,
    maxTrackSeconds: cs.maxTrackSeconds,
    minTrackLengthSeconds: cs.minTrackLengthSeconds,
    playlistIds: [],
    playlistStrict: false,
    playlistExhaust: false,
    playlistInOrder: false,
    excludedPlaylistIds: [],
  };

  try {
    await settings.update({ shows: [...shows, show] });
    const next = settings.get().shows || [];
    const installed = next.find((sh: any) => String(sh.name).trim().toLowerCase() === wanted) || null;
    queue.log('scheduler', `[shows] community "${slug}" installed via admin UI as "${cs.name}"`);
    res.json({ shows: next, show: installed });
  } catch (err: any) {
    queue.log('error', `POST /shows/community/${slug}/install failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

// Play in order: where a SAVED show's walk stands — the track its next in-order
// pick would choose, through the same resolveInOrderNext the pick branch calls,
// so the editor's "next up" cannot drift from the air. Read-only.
router.get('/shows/:id/playlist-position', requireAdmin, async (req, res) => {
  const id = String(req.params.id);
  await settings.load();
  const show = settings.resolveShowById(id);
  if (!show) return res.status(404).json({ error: `no such show: ${id}` });
  if (!isInOrderShow(show)) return res.json({ inOrder: false, next: null });
  try {
    const next = await resolveInOrderNext(show, { busyIds: queue.queuedIds() });
    if (!next.ok) return res.json({ inOrder: true, next: null, reason: next.reason });
    res.json({
      inOrder: true,
      next: { index: next.index, total: next.total, title: next.track.title ?? null, artist: next.track.artist ?? null },
    });
  } catch (err: any) {
    queue.log('error', `GET /shows/${id}/playlist-position failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Play in order: back to the top. The next in-order pick is the first eligible
// track of the anchor. Answers ok even when there was no saved position.
router.delete('/shows/:id/playlist-position', requireAdmin, async (req, res) => {
  const id = String(req.params.id);
  await settings.load();
  if (!settings.resolveShowById(id)) return res.status(404).json({ error: `no such show: ${id}` });
  try {
    const cleared = await playlistCursors.reset(id);
    if (cleared) queue.log('scheduler', `[shows] "${id}" running order reset to the top via admin UI`);
    res.json({ ok: true });
  } catch (err: any) {
    queue.log('error', `DELETE /shows/${id}/playlist-position failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Removes one show and unschedules it from the grid in the SAME update:
// validateScheduleStrict rejects a slot referencing an unknown show, so shows
// and a cleaned schedule must persist together. Reads the persisted state, not
// whatever the panel is holding locally.
router.delete('/shows/:id', requireAdmin, async (req, res) => {
  const id = String(req.params.id);

  await settings.load();
  const s = settings.get();
  const existing = s.shows || [];
  const shows = existing.filter((sh: any) => sh.id !== id);
  if (shows.length === existing.length) {
    return res.status(404).json({ error: `no such show: ${id}` });
  }

  // Null out every slot that pointed at the deleted show; leave the rest intact.
  const week = s.schedule || {};
  const schedule: Record<number, Array<string | null>> = {};
  for (let d = 0; d < 7; d++) {
    const day = Array.isArray(week[d]) ? week[d] : [];
    schedule[d] = Array.from({ length: 24 }, (_, h) => (day[h] === id ? null : (day[h] ?? null)));
  }

  try {
    await settings.update({ shows, schedule });
    const next = settings.get();
    queue.log('scheduler', `[shows] "${id}" deleted via admin UI`);
    res.json({ shows: next.shows, schedule: next.schedule });
  } catch (err: any) {
    queue.log('error', `DELETE /shows/${id} failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

// Upsert ONE show: merge into the persisted list (replace on id match, else
// append) and let settings.update() re-validate the whole array. The schedule
// is untouched, and a client-minted s_ id survives validation so grid slots
// already pointing at the show stay valid.
router.post('/shows', requireAdmin, validateBodyAsync(showPostContext), async (req, res) => {
  const incoming = req.body.show;

  await settings.load();
  const existing = settings.get().shows || [];
  const id = typeof incoming.id === 'string' ? incoming.id : '';
  const idx = id ? existing.findIndex((s: any) => s.id === id) : -1;

  let merged: any[];
  if (idx >= 0) {
    merged = existing.map((s: any, i: number) => (i === idx ? incoming : s));
  } else {
    if (existing.length >= settings.SHOWS_LIMIT) {
      return res.status(409).json({ error: `the show list is full (${settings.SHOWS_LIMIT} shows max) — remove one first` });
    }
    merged = [...existing, incoming];
  }

  try {
    await settings.update({ shows: merged });
    const next = settings.get().shows || [];
    const saved = (id && next.find((s: any) => s.id === id)) || next[next.length - 1] || null;
    queue.log('scheduler', `[shows] "${saved?.id || id}" ${idx >= 0 ? 'edited' : 'added'} via admin editor`);
    if (saved?.generation?.mode === 'generated') {
      void prepareUpcomingGeneratedShows({ showId: saved.id })
        .catch(err => queue.log('error', `[shows] generated show preparation failed after edit: ${err.message}`));
    }
    res.json({ shows: next, show: saved });
  } catch (err: any) {
    queue.log('error', `POST /shows failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

// What `until: 'schedule-change'` would resolve to if the takeover started now.
// Advisory only: POST /schedule/override resolves the window again at its own
// startedAt. Kept off the public GET /schedule because the scan walks a minute
// at a time over a twelve-hour horizon.
router.get('/schedule/next-change', requireAdmin, async (_req, res) => {
  try {
    await settings.load();
    res.json(resolveTakeoverWindowNow());
  } catch (err: any) {
    queue.log('error', `GET /schedule/next-change failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Preparation is a command with no schedule side effects. Activation consumes
// the accepted draft, never a second model generation.
router.post('/schedule/takeover/prepare', requireAdmin, validateBody(takeoverPreviewRequestSchema), async (req, res) => {
  try { res.json(await prepareTakeoverPreview(req.body)); }
  catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    queue.log('error', `Takeover preparation failed: ${message}`);
    res.status(502).json({ error: message });
  }
});
router.post('/schedule/takeover/activate', requireAdmin, validateBody(z.object({ token: z.string().uuid() })), async (req, res) => {
  try {
    const result = await activateTakeoverPreview(req.body.token);
    if (result.newlyActivated) void rollSessionNow({ manual: true, reason: 'prepared Sub/Show takeover started' });
    res.json(result);
  } catch (err: unknown) {
    res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Pin a show or Default programming for a bounded window; re-POSTing replaces a
// live one. The session roll is fire-and-forget, so the switch lands on-air at
// the next track boundary. The roster lookup stays here because "no such show"
// needs server state and answers 404, not 400. `until: 'schedule-change'`
// (#1601) is spent here and never persisted: what is stored is an ordinary
// ScheduleOverride either way.
router.post('/schedule/override', requireAdmin, validateBody(scheduleOverrideRequestSchema), async (req, res) => {
  const { showId, minutes, until } = req.body as {
    showId: string | null;
    minutes?: number;
    until: 'fixed' | 'schedule-change';
  };

  await settings.load();
  // The same two predicates the resolver reads the stored target with, so the
  // route cannot answer a target differently from the resolver.
  const pinnedId = takeoverShowId(req.body);
  const show = pinnedId ? (settings.get().shows || []).find((s: any) => s.id === pinnedId) : null;
  if (!isDefaultTakeover(req.body) && !show) {
    return res.status(404).json({ error: `no such show: ${showId}` });
  }

  if (show?.generation?.mode === 'generated') {
    return res.status(409).json({ error: 'Prepare a Sub/Show template before starting its takeover.' });
  }

  const startedAt = Date.now();
  // Must resolve AFTER settings.load(): a stale roster ends the window at a
  // boundary the saved schedule no longer has.
  const resolved = until === 'schedule-change' ? resolveTakeoverWindowNow(startedAt) : null;
  // `minutes` is optional in the schema only under 'schedule-change', so the
  // non-null assertions below are exactly what the schema guarantees.
  const windowMinutes = resolved ? resolved.minutes : minutes!;
  const expiresAt = resolved ? resolved.expiresAt : startedAt + minutes! * 60_000;
  const override = { showId, startedAt, expiresAt };
  // So the booth log records a clamp rather than an unexplained duration.
  const reason = resolved
    ? {
      schedule: ' (until the schedule changes)',
      maximum: ' (the schedule has no change in reach)',
      ceiling: ' (the next change is further out than a takeover can run)',
    }[resolved.source]
    : '';
  try {
    await settings.update({ scheduleOverride: override });
    queue.log(
      'scheduler',
      show
        ? `[takeover] "${show.name}" pinned for ${windowMinutes} min${reason} via admin UI`
        : `[takeover] Default programming selected for ${windowMinutes} min${reason} via admin UI`,
    );
    void rollSessionNow({ manual: true, reason: 'takeover started' });
    res.json({ override });
  } catch (err: any) {
    queue.log('error', `POST /schedule/override failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

// Cancel a takeover early. Idempotent: clearing an already-clear override
// succeeds without airing anything.
router.delete('/schedule/override', requireAdmin, async (req, res) => {
  await settings.load();
  const existing = settings.get().scheduleOverride;
  try {
    await settings.update({ scheduleOverride: null });
    if (existing) {
      queue.log('scheduler', '[takeover] cancelled via admin UI — back to the weekly schedule');
      void rollSessionNow({ manual: true, reason: 'takeover cancelled' });
    }
    res.json({ override: null });
  } catch (err: any) {
    queue.log('error', `DELETE /schedule/override failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

// Saves ONLY the weekly grid. validateBody runs the shared schema with
// `showIds: null`, SHAPE only; ids are resolved afterwards by
// resolveScheduleSlots, which DROPS and counts an unknown show rather than
// rejecting, because the editor can hold a show the operator hasn't saved yet.
router.put('/schedule', requireAdmin, validateBody(scheduleSaveSchema), async (req, res) => {
  await settings.load();
  const ids = (settings.get().shows || []).map((s: any) => s.id);
  const { schedule, dropped } = resolveScheduleSlots(req.body as any, ids);

  try {
    await settings.update({ schedule });
    queue.log('scheduler', `[shows] schedule saved via admin editor${dropped ? ` (${dropped} orphan slot(s) dropped)` : ''}`);
    void prepareUpcomingGeneratedShows()
      .catch(err => queue.log('error', `[shows] generated show preparation failed after schedule save: ${err.message}`));
    res.json({ schedule: settings.get().schedule, dropped });
  } catch (err: any) {
    queue.log('error', `PUT /schedule failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});
