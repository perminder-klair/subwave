// Admin-gated Navidrome playlist management — backs the Playlists tab and the
// add-to-playlist flow in /admin/library. Thin wrappers over the Subsonic
// playlist API: everything reads live (no memo) so the UI reflects mutations
// immediately; the picker's own 30-min playlist memo catches up on its own.
import express from 'express';
import { requireAdmin } from '../middleware/auth.js';
// Playlist mutation is a Subsonic/Navidrome capability, not part of the
// MusicSource facade — import the source module directly.
import * as subsonic from '../music/sources/subsonic.js';
import { queue } from '../broadcast/queue.js';

export const router = express.Router();

function parseIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim());
}

// GET /playlists — all playlists visible to the configured Navidrome account.
router.get('/playlists', requireAdmin, async (_req, res) => {
  try {
    const playlists = await subsonic.getPlaylists();
    res.json({
      playlists: (Array.isArray(playlists) ? playlists : []).map((p: any) => ({
        id: p.id,
        name: p.name,
        songCount: p.songCount ?? 0,
        durationSec: p.duration ?? 0,
        owner: p.owner || '',
        public: !!p.public,
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /playlists/:id — playlist entries, in order (indexes matter: Subsonic
// removes by position, and the UI sends back the indexes it displayed).
router.get('/playlists/:id', requireAdmin, async (req, res) => {
  try {
    const entries = await subsonic.getPlaylist(req.params.id);
    res.json({
      entries: entries.map((s: any) => ({
        id: s.id,
        title: s.title,
        artist: s.artist,
        album: s.album,
        year: s.year,
        durationSec: s.duration ?? 0,
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /playlists — { name, songIds? } → create in Navidrome.
router.post('/playlists', requireAdmin, async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name) return res.status(400).json({ error: 'name is required' });
  const songIds = parseIds(req.body?.songIds);
  try {
    const playlist = await subsonic.createPlaylist(name, songIds);
    queue.log('info', `playlist "${name}" created (${songIds.length} tracks)`);
    res.json({ playlist: playlist || null, added: songIds.length });
  } catch (err: any) {
    queue.log('error', `playlist create failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /playlists/:id/tracks — { songIds } → append.
router.post('/playlists/:id/tracks', requireAdmin, async (req, res) => {
  const songIds = parseIds(req.body?.songIds);
  if (songIds.length === 0) return res.status(400).json({ error: 'songIds is required' });
  try {
    const added = await subsonic.addToPlaylist(req.params.id, songIds);
    res.json({ added });
  } catch (err: any) {
    queue.log('error', `playlist append failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /playlists/:id — { name?, public? } → rename / visibility.
router.patch('/playlists/:id', requireAdmin, async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : undefined;
  const isPublic = typeof req.body?.public === 'boolean' ? req.body.public : undefined;
  if (name === undefined && isPublic === undefined) {
    return res.status(400).json({ error: 'nothing to update — send name and/or public' });
  }
  if (name !== undefined && !name) return res.status(400).json({ error: 'name cannot be empty' });
  try {
    await subsonic.updatePlaylistMeta(req.params.id, { name, public: isPublic });
    res.json({ ok: true });
  } catch (err: any) {
    queue.log('error', `playlist update failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /playlists/:id/tracks — { indexes } → remove by position.
router.delete('/playlists/:id/tracks', requireAdmin, async (req, res) => {
  const indexes = Array.isArray(req.body?.indexes)
    ? req.body.indexes.filter((n: unknown) => Number.isInteger(n) && (n as number) >= 0)
    : [];
  if (indexes.length === 0) return res.status(400).json({ error: 'indexes is required' });
  try {
    await subsonic.removeFromPlaylist(req.params.id, indexes);
    res.json({ removed: indexes.length });
  } catch (err: any) {
    queue.log('error', `playlist track removal failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /playlists/:id — delete the playlist itself.
router.delete('/playlists/:id', requireAdmin, async (req, res) => {
  try {
    await subsonic.deletePlaylist(req.params.id);
    queue.log('info', `playlist ${req.params.id} deleted`);
    res.json({ ok: true });
  } catch (err: any) {
    queue.log('error', `playlist delete failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});
