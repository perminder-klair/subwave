// Admin-gated Navidrome playlist management. Thin wrappers over the Subsonic
// playlist API; everything reads live (no memo) so the UI reflects mutations at
// once — the picker's own 30-min playlist memo catches up on its own.
import express from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import * as subsonic from '../music/subsonic.js';
import * as library from '../music/library.js';
import { queue } from '../broadcast/queue.js';
import { generatePlaylist, type GenerateInput } from '../music/playlist-gen.js';
import * as genJobs from '../music/playlist-jobs.js';
import * as recipes from '../music/playlist-recipes.js';
import type { StoredRecipe } from '../music/playlist-recipes.js';
import { syncRecipe } from '../music/playlist-sync.js';
// Shared schemas, mirrored to the web builder. The middleware replaces req.body
// with the parsed object, so handlers read already-coerced values.
import {
  playlistAppendSchema,
  playlistGenerateSchema,
  playlistPatchSchema,
  playlistRemoveTracksSchema,
  playlistSaveSchema,
} from '../schemas/playlist.js';

export const router = express.Router();

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

// Entries stay in order: Subsonic removes by position and the UI sends back the
// indexes it displayed.
router.get('/playlists/:id', requireAdmin, async (req, res) => {
  try {
    const entries = await subsonic.getPlaylist(req.params.id);
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
          genre: subsonic.songGenres(s).join(', ') || tag?.genres?.join(', ') || null,
          moods: tag?.moods ?? [],
          energy: tag?.energy ?? null,
        };
      }),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Create, or OVERWRITE an existing playlist's tracks + name when playlistId is
// present.
router.post('/playlists', requireAdmin, validateBody(playlistSaveSchema), async (req, res) => {
  const { name, songIds, playlistId, keepInSync } = req.body as {
    name: string; songIds: string[]; playlistId?: string; keepInSync: boolean;
  };
  try {
    const playlist = await subsonic.createPlaylist(name, songIds, { playlistId });
    // createPlaylist doesn't touch the name on an overwrite; patch it separately.
    if (playlistId) await subsonic.updatePlaylistMeta(playlistId, { name, public: true });
    const id = playlist?.id || playlistId;
    if (id) {
      if (keepInSync) recipes.upsert({ playlistId: id, name, recipe: req.body.recipe as StoredRecipe });
      else recipes.remove(id);
    }
    queue.log('info', `playlist "${name}" ${playlistId ? 'overwritten' : 'created'} (${songIds.length} tracks)${keepInSync ? ' [synced]' : ''}`);
    res.json({ playlist: playlist || null, added: songIds.length });
  } catch (err: any) {
    queue.log('error', `playlist ${playlistId ? 'overwrite' : 'create'} failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

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

function finishGenerate(result: Awaited<ReturnType<typeof generatePlaylist>>) {
  if (!result.tracks.length) {
    return { ...result, message: 'nothing matched — try loosening the filters, removing seeds, or a broader vibe' };
  }
  queue.log('info', `playlist generated (${result.tracks.length} tracks, pool ${result.poolSize}${result.usedFallback ? ', deterministic fallback' : ''})`);
  return result;
}

// Returns an UNSAVED candidate list; never mutates Navidrome. Synchronous and
// can take minutes, so anything behind Cloudflare (~100s origin cutoff) must use
// the jobs flow below.
router.post('/playlists/generate', requireAdmin, validateBody(playlistGenerateSchema), async (req, res) => {
  const input = req.body as GenerateInput;
  try {
    res.json(finishGenerate(await generatePlaylist(input)));
  } catch (err: any) {
    queue.log('error', `playlist generate failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/playlists/generate/jobs', requireAdmin, validateBody(playlistGenerateSchema), (req, res) => {
  const input = req.body as GenerateInput;
  const job = genJobs.create();
  if (!job) return res.status(429).json({ error: 'too many generations already running — collect or wait for one first' });
  generatePlaylist(input).then(
    (result) => genJobs.complete(job.id, finishGenerate(result)),
    (err: any) => {
      queue.log('error', `playlist generate failed: ${err.message}`);
      genJobs.fail(job.id, err.message);
    },
  );
  res.status(202).json({ jobId: job.id });
});

// 404 once expired, or after a controller restart — the job store is in-memory.
router.get('/playlists/generate/jobs/:id', requireAdmin, (req, res) => {
  const job = genJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'unknown or expired generation job — start a new one' });
  if (job.status === 'running') return res.json({ status: 'running' });
  if (job.status === 'error') return res.json({ status: 'error', error: job.error || 'generation failed' });
  res.json({ status: 'done', result: job.result });
});

router.post('/playlists/:id/tracks', requireAdmin, validateBody(playlistAppendSchema), async (req, res) => {
  const { songIds } = req.body as { songIds: string[] };
  try {
    const added = await subsonic.addToPlaylist(String(req.params.id), songIds);
    res.json({ added });
  } catch (err: any) {
    queue.log('error', `playlist append failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/playlists/:id', requireAdmin, validateBody(playlistPatchSchema), async (req, res) => {
  const { name, public: isPublic } = req.body as { name?: string; public?: boolean };
  try {
    await subsonic.updatePlaylistMeta(String(req.params.id), { name, public: isPublic });
    res.json({ ok: true });
  } catch (err: any) {
    queue.log('error', `playlist update failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/playlists/:id/tracks', requireAdmin, validateBody(playlistRemoveTracksSchema), async (req, res) => {
  const { indexes } = req.body as { indexes: number[] };
  try {
    await subsonic.removeFromPlaylist(String(req.params.id), indexes);
    res.json({ removed: indexes.length });
  } catch (err: any) {
    queue.log('error', `playlist track removal failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

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
