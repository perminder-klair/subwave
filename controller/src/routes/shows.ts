// Admin show routes: per-show upsert/delete, the weekly grid, timed takeovers,
// and the one-tap community install. Reading shows still travels inside
// GET/POST /settings, and settings.update() stays the validation chokepoint.

import express from 'express';
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
import { resolveTakeoverWindowNow } from '../broadcast/takeover-window.js';
import { diagnoseShowCandidates } from '../music/show-candidates.js';

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
    res.json({ schedule: settings.get().schedule, dropped });
  } catch (err: any) {
    queue.log('error', `PUT /schedule failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});
