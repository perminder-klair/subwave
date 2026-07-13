// Admin-gated install of a community SHOW template into the station's show list.
//
// A shared show (community, fetched via community/registry.ts) carries
// only portable substance — a brief (topic) + music-steering filters + mode
// flags. Everything install-specific is re-bound HERE: the host persona defaults
// to the station's active persona, there are no guests, no theme override, no
// playlist anchors, and the show is NOT placed in the weekly schedule grid. The
// operator then edits it in /admin/shows to assign a persona and drop it into a
// slot. Mirrors the community persona install (routes/personas.ts).
//
// Reading/writing shows themselves still travels inside GET/POST /settings — this
// route only adds the one-tap community install (validateShowsStrict runs inside
// settings.update(), which mints the s_ id and routes the show into
// state/schedule.json).

import express from 'express';
import * as settings from '../settings.js';
import { requireAdmin } from '../middleware/auth.js';
import { readCommunityShow } from '../shows/community.js';
import { SLUG_RE } from '../skills/loader.js';
import { queue } from '../broadcast/queue.js';

export const router = express.Router();

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

  // Host defaults to the active persona (always present on a booted station); the
  // operator reassigns it in /admin/shows. No id supplied → validateShowsStrict
  // mints an s_ id. themeId/playlists empty; not placed in the schedule grid.
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
    filtersStrict: cs.filtersStrict,
    maxTrackSeconds: cs.maxTrackSeconds,
    playlistIds: [],
    playlistStrict: false,
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

// ---------------------------------------------------------------------------
// DELETE /shows/:id — remove one show and persist immediately, so a delete
// takes effect on its own action instead of waiting for a "Save schedule" that
// also commits every other pending edit. The deleted show is also unscheduled
// from every weekly grid slot in the SAME update — validateScheduleStrict
// rejects a slot that references an unknown show, so shows + a cleaned schedule
// must persist together. Operates on the server's persisted state, so it works
// regardless of any unsaved edits the admin panel is holding locally.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// POST /shows — upsert ONE show (add or edit), so the editor's "Save show"
// persists just that show, independent of any other unsaved/half-finished show
// the panel is holding. Merges the incoming show into the server's persisted
// list (replace when the id matches, else append), then settings.update()
// re-validates the whole array — the other persisted shows are already valid, so
// only the incoming one can fail. The schedule is untouched (a new show isn't
// referenced yet; an edited show keeps its id). A client-minted `s_` id survives
// validateShowsStrict, so grid slots that already point at the show stay valid.
// ---------------------------------------------------------------------------
router.post('/shows', requireAdmin, async (req, res) => {
  const incoming = req.body?.show;
  if (!incoming || typeof incoming !== 'object') {
    return res.status(400).json({ error: 'missing show' });
  }

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

// ---------------------------------------------------------------------------
// PUT /schedule — save ONLY the weekly grid, so "Save schedule" writes the
// schedule and nothing else (show definitions persist via POST /shows / the
// delete route). Any slot pointing at a show that isn't persisted (a locally
// added show the operator hasn't saved yet, or one just removed) is dropped
// rather than rejected — validateScheduleStrict would otherwise throw on an
// unknown show. `dropped` tells the client how many slots were skipped.
// ---------------------------------------------------------------------------
router.put('/schedule', requireAdmin, async (req, res) => {
  await settings.load();
  const ids = new Set((settings.get().shows || []).map((s: any) => s.id));
  const raw = (req.body?.schedule ?? req.body) || {};

  const schedule: Record<number, Array<string | null>> = {};
  let dropped = 0;
  for (let d = 0; d < 7; d++) {
    const day = Array.isArray(raw[d]) ? raw[d] : [];
    schedule[d] = Array.from({ length: 24 }, (_, h) => {
      const v = day[h];
      if (typeof v === 'string' && v) {
        if (ids.has(v)) return v;
        dropped++;
        return null;
      }
      return null;
    });
  }

  try {
    await settings.update({ schedule });
    queue.log('scheduler', `[shows] schedule saved via admin editor${dropped ? ` (${dropped} orphan slot(s) dropped)` : ''}`);
    res.json({ schedule: settings.get().schedule, dropped });
  } catch (err: any) {
    queue.log('error', `PUT /schedule failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});
