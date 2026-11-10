import express from 'express';
import { requireAdmin } from '../../middleware/auth.js';
import * as subsonic from '../../music/subsonic.js';
import * as flows from '../../music/sub-flow.js';
import { queue } from '../../broadcast/queue.js';
import { flowPlaybackStatus } from '../../broadcast/liquidsoap-control.js';
import { discardFlow } from '../../music/sub-flow-playback.js';

export const router = express.Router();

router.post('/library/sub-flow/:id/queue', requireAdmin, async (req, res) => {
  const revision = req.body?.revision;
  if (!Number.isInteger(revision) || revision < 1) return res.status(400).json({ error: 'A revision is required' });
  try {
    await flowPlaybackStatus();
    const prepared = await flows.preparePlayback(req.params.id, revision);
    try {
      const depth = await queue.queueFlow(prepared);
      res.json({ ok: true, queueDepth: depth, occurrenceId: prepared.occurrenceId });
    } catch (error) { await discardFlow(prepared); throw error; }
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Flow could not be queued' }); }
});

router.post('/library/sub-flow/join-preview', requireAdmin, async (req, res) => {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  res.once('close', cancel);
  try {
    const audio = await flows.previewJoin(req.body?.trackIds, abort.signal);
    if (!abort.signal.aborted) res.set('Cache-Control', 'no-store').type('audio/wav').send(audio);
  } catch (error) {
    if (!abort.signal.aborted) res.status(400).json({ error: error instanceof Error ? error.message : 'Join preview could not be prepared' });
  } finally { res.off('close', cancel); }
});

router.get('/library/sub-flow', requireAdmin, (_req, res) => {
  try { res.json({ flows: flows.list() }); }
  catch { res.status(500).json({ error: 'Saved Flows could not be read' }); }
});

router.get('/library/sub-flow/:id/album', requireAdmin, async (req, res) => {
  const flow = flows.list().find(flow => flow.id === req.params.id);
  if (!flow) return res.status(404).json({ error: 'Flow not found' });
  try {
    const song = await subsonic.getSong(flow.tracks[0]!.id);
    if (!song?.albumId) throw new Error('The saved track’s album is unavailable');
    const result = await subsonic.getAlbumWithSongs(song.albumId, { requireComplete: true });
    if (!result) throw new Error('The saved track’s album is unavailable');
    const album = result.album;
    res.json({ album: { id: album.id, name: album.name, artist: album.artist ?? null,
      year: album.year ?? null, coverArt: album.coverArt ?? null } });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Album could not be loaded' });
  }
});

router.post('/library/sub-flow', requireAdmin, async (req, res) => {
  try { res.status(201).json({ flow: await flows.save(null, req.body) }); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Flow could not be saved' }); }
});

router.put('/library/sub-flow/:id', requireAdmin, async (req, res) => {
  try { res.json({ flow: await flows.save(req.params.id, req.body) }); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Flow could not be saved' }); }
});

router.patch('/library/sub-flow/:id/enabled', requireAdmin, async (req, res) => {
  const { revision, enabled } = req.body ?? {};
  if (!Number.isInteger(revision) || revision < 1 || typeof enabled !== 'boolean') return res.status(400).json({ error: 'A revision and enabled state are required' });
  try { res.json({ flow: await flows.setEnabled(req.params.id, revision, enabled) }); }
  catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : 'Flow could not be changed' }); }
});

router.delete('/library/sub-flow/:id', requireAdmin, (req, res) => {
  const revision = Number(req.query.revision);
  if (!Number.isInteger(revision) || revision < 1) return res.status(400).json({ error: 'A revision is required' });
  try { flows.remove(req.params.id, revision); res.json({ ok: true }); }
  catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : 'Flow could not be deleted' }); }
});

router.get('/library/sub-flow/albums', requireAdmin, async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!q) return res.status(400).json({ error: 'Search text is required' });
  try {
    const albums = await subsonic.searchAlbums(q);
    res.json({ albums: albums.map((album: any) => ({
      id: album.id, name: album.name, artist: album.artist ?? null,
      year: album.year ?? null, coverArt: album.coverArt ?? null,
    })) });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Album search failed' });
  }
});

router.get('/library/sub-flow/albums/:id/tracks', requireAdmin, async (req, res) => {
  try {
    const songs = await flows.albumTracks(req.params.id);
    res.json({ tracks: songs.map((song: any) => ({
      id: song.id, title: song.title, artist: song.artist ?? null,
      album: song.album ?? null, duration: song.duration ?? null,
      discNumber: song.discNumber ?? null, track: song.track ?? null, order: song.order,
    })) });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Album tracks could not be loaded' });
  }
});
