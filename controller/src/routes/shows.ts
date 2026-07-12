// Admin-gated install of a community SHOW template into the station's show list.
//
// A shared show (subwave-community, fetched via community/registry.ts) carries
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
