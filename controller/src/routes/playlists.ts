// Admin-gated Navidrome playlist management — backs the Playlists tab and the
// add-to-playlist flow in /admin/library. Thin wrappers over the Subsonic
// playlist API: everything reads live (no memo) so the UI reflects mutations
// immediately; the picker's own 30-min playlist memo catches up on its own.
import express from 'express';
import { requireAdmin } from '../middleware/auth.js';
// Playlist mutation is a Subsonic/Navidrome capability, not part of the
// MusicSource facade — import the source module directly.
import * as subsonic from '../music/sources/subsonic.js';
import { songGenres } from '../music/source.js';
import * as library from '../music/library.js';
import { queue } from '../broadcast/queue.js';
import { generatePlaylist, type GenerateInput } from '../music/playlist-gen.js';
import * as recipes from '../music/playlist-recipes.js';
import { syncRecipe } from '../music/playlist-sync.js';

export const router = express.Router();

// A recipe body accompanies a "keep in sync" save — the same shape /generate
// takes, minus excludeTrackIds.
function readRecipe(body: any) {
  return {
    prompt: typeof body?.prompt === 'string' ? body.prompt : undefined,
    seedTrackIds: parseIds(body?.seedTrackIds),
    seedArtist: typeof body?.seedArtist === 'string' ? body.seedArtist : undefined,
    knobs: body?.knobs && typeof body.knobs === 'object' ? body.knobs : {},
    sources: body?.sources && typeof body.sources === 'object' ? body.sources : {},
  };
}

function parseIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim());
}

// GET /playlists — all playlists visible to the configured Navidrome account.
router.get('/playlists', requireAdmin, async (_req, res) => {
  try {
    const playlists = await subsonic.getPlaylists();
    res.json({
      playlists: (Array.isArray(playlists) ? playlists : []).map((p: any) => {
        const rec = recipes.get(p.id);
        return {
          id: p.id,
          name: p.name,
          songCount: p.songCount ?? 0,
          durationSec: p.duration ?? 0,
          owner: p.owner || '',
          public: !!p.public,
          synced: !!rec,
          lastSyncedAt: rec?.lastSyncedAt ?? null,
        };
      }),
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
    // Merge library tags (same pattern as /dj/search's toAdminRow) so the
    // builder's energy graph / mood chips work on loaded playlists too.
    await library.load();
    res.json({
      entries: entries.map((s: any) => {
        const tag = library.get(s.id);
        return {
          id: s.id,
          title: s.title,
          artist: s.artist,
          album: s.album,
          year: s.year,
          durationSec: s.duration ?? 0,
          genre: songGenres(s).join(', ') || tag?.genres?.join(', ') || null,
          moods: tag?.moods ?? [],
          energy: tag?.energy ?? null,
        };
      }),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /playlists — { name, songIds?, playlistId? } → create in Navidrome, or
// OVERWRITE an existing playlist's tracks + name when playlistId is present (the
// builder's "save over an existing playlist").
router.post('/playlists', requireAdmin, async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name) return res.status(400).json({ error: 'name is required' });
  const songIds = parseIds(req.body?.songIds);
  const playlistId = typeof req.body?.playlistId === 'string' && req.body.playlistId.trim()
    ? req.body.playlistId.trim()
    : undefined;
  const keepInSync = req.body?.keepInSync === true;
  try {
    const playlist = await subsonic.createPlaylist(name, songIds, { playlistId });
    // A wholesale overwrite via createPlaylist doesn't touch the name, so patch
    // it separately in case the operator renamed while saving over.
    if (playlistId) await subsonic.updatePlaylistMeta(playlistId, { name, public: true });
    // Recipe upsert/remove for sync (append-only). `keepInSync` needs the recipe
    // body; toggling it off drops the entry.
    const id = playlist?.id || playlistId;
    if (id) {
      if (keepInSync) recipes.upsert({ playlistId: id, name, recipe: readRecipe(req.body?.recipe || {}) });
      else recipes.remove(id);
    }
    queue.log('info', `playlist "${name}" ${playlistId ? 'overwritten' : 'created'} (${songIds.length} tracks)${keepInSync ? ' [synced]' : ''}`);
    res.json({ playlist: playlist || null, added: songIds.length });
  } catch (err: any) {
    queue.log('error', `playlist ${playlistId ? 'overwrite' : 'create'} failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /playlists/:id/sync — manual "Sync now" for a recipe-backed playlist.
router.post('/playlists/:id/sync', requireAdmin, async (req, res) => {
  const entry = recipes.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'this playlist is not sync-enabled' });
  try {
    const r = await syncRecipe(entry);
    if (r.prunedMissing) { recipes.remove(req.params.id); return res.status(404).json({ error: 'playlist no longer exists in Navidrome' }); }
    queue.log('info', `playlist "${entry.name}" synced (+${r.added})`);
    res.json({ added: r.added });
  } catch (err: any) {
    queue.log('error', `playlist sync failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /playlists/generate — { prompt?, seedTrackIds?, seedArtist?, knobs?,
// sources?, excludeTrackIds? } → an UNSAVED, ordered candidate list. The
// operator edits it, then saves via POST /playlists. Never mutates Navidrome.
router.post('/playlists/generate', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const input: GenerateInput = {
    prompt: typeof b.prompt === 'string' ? b.prompt : undefined,
    seedTrackIds: parseIds(b.seedTrackIds),
    seedArtist: typeof b.seedArtist === 'string' ? b.seedArtist : undefined,
    knobs: b.knobs && typeof b.knobs === 'object' ? b.knobs : {},
    sources: b.sources && typeof b.sources === 'object' ? b.sources : {},
    excludeTrackIds: parseIds(b.excludeTrackIds),
  };
  const hasIntent = Boolean(
    input.prompt?.trim() ||
    input.seedTrackIds?.length ||
    input.seedArtist?.trim() ||
    input.sources?.recentlyAdded ||
    input.knobs?.moods?.length ||
    input.knobs?.genres?.length ||
    input.knobs?.artists?.length ||
    input.knobs?.energies?.length ||
    input.knobs?.eras?.length ||
    input.knobs?.minBpm ||
    input.knobs?.maxBpm ||
    input.knobs?.instrumentalOnly,
  );
  if (!hasIntent) {
    return res.status(400).json({ error: 'give a prompt, seeds, a source, or at least one knob to generate from' });
  }
  try {
    const result = await generatePlaylist(input);
    if (!result.tracks.length) {
      return res.json({ ...result, message: 'nothing matched — try loosening the filters, removing seeds, or a broader vibe' });
    }
    queue.log('info', `playlist generated (${result.tracks.length} tracks, pool ${result.poolSize}${result.usedFallback ? ', deterministic fallback' : ''})`);
    res.json(result);
  } catch (err: any) {
    queue.log('error', `playlist generate failed: ${err.message}`);
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
    recipes.remove(req.params.id);
    queue.log('info', `playlist ${req.params.id} deleted`);
    res.json({ ok: true });
  } catch (err: any) {
    queue.log('error', `playlist delete failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});
