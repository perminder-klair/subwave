import express from 'express';
import { requireAdmin } from '../../middleware/auth.js';
import * as blocklist from '../../music/blocklist.js';
import * as db from '../../music/library-db.js';
import * as subsonic from '../../music/subsonic.js';
import { queue } from '../../broadcast/queue.js';
import { refreshAutoPlaylist } from '../../broadcast/scheduler.js';
import { validateBody } from '../../middleware/validate.js';
import { blockEntrySchema, blockRuleSchema } from '../../schemas/blocklist.js';

export const router = express.Router();

// Never-play blocklist at track/album/artist granularity. Enforcement lives in
// music/blocklist.ts; these routes only manage the list.

router.get('/library/blocklist', requireAdmin, (_req, res) => {
  // Rules ride the same listing with live stats: `active` (blocking right now) and
  // `matchCount` (library-wide reach, so a typo'd value reads 0).
  let rules: ReturnType<typeof blocklist.rulesWithStats> = [];
  if (blocklist.listRules().length) {
    let rows: any[] = [];
    try { rows = db.ruleMatchRows(); } catch {}
    rules = blocklist.rulesWithStats(rows);
  }
  res.json({ entries: blocklist.list(), rules });
});

// Rule entries (#1300). Registered BEFORE the entry routes: DELETE
// /library/blocklist/:type/:id would otherwise swallow /rules/:id with
// type='rules'. Same schema blocklist.addRule reaches via validateRulePatch.
router.post(
  '/library/blocklist/rules',
  requireAdmin,
  validateBody(blockRuleSchema, { messages: 'verbatim' }),
  async (req, res) => {
  try {
    const rule = await blocklist.addRule(req.body);
    queue.log('blocked', `rule "${rule.label}" (${rule.field}: ${rule.values.join(', ')}) added to the never-play blocklist`);
    // Same side-effects as adding an id entry: drop now-blocked upcoming tracks,
    // rebuild auto.m3u so the LLM-free coast stops carrying them.
    const purged = queue.purgeBlocked();
    refreshAutoPlaylist().catch((err: any) => queue.log('error', `blocklist auto-playlist refresh failed: ${err.message}`));
    res.status(201).json({ rule, purged });
  } catch (err) {
    // Validation errors are the operator's typo, not a server fault.
    res.status(400).json({ error: err.message });
  }
  },
);

router.put(
  '/library/blocklist/rules/:id',
  requireAdmin,
  validateBody(blockRuleSchema, { messages: 'verbatim' }),
  async (req, res) => {
  try {
    const rule = await blocklist.updateRule(String(req.params.id), req.body);
    if (!rule) return res.status(404).json({ error: 'no such rule' });
    queue.log('blocked', `rule "${rule.label}" updated on the never-play blocklist`);
    const purged = queue.purgeBlocked();
    refreshAutoPlaylist().catch((err: any) => queue.log('error', `blocklist auto-playlist refresh failed: ${err.message}`));
    res.json({ rule, purged });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
  },
);

router.delete('/library/blocklist/rules/:id', requireAdmin, async (req, res) => {
  try {
    const removed = await blocklist.removeRule(req.params.id);
    if (!removed) return res.status(404).json({ error: 'no such rule' });
    queue.log('blocked', `rule ${req.params.id} removed from the never-play blocklist`);
    // No purge on remove: auto.m3u picks the track back up on its next refresh.
    res.status(204).end();
  } catch (err) {
    queue.log('error', `/library/blocklist/rules delete failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Body is either { type, trackId } (server resolves album/artist ids and display
// snapshots) or a pre-resolved { type, id, name?, artist?, album? }.
router.post(
  '/library/blocklist',
  requireAdmin,
  // Shape only: resolving `{type, trackId}` needs Subsonic, so which form
  // arrived is decided below.
  validateBody(blockEntrySchema, { messages: 'verbatim' }),
  async (req, res) => {
  const type = req.body.type;
  try {
    let input: { type: blocklist.BlockType; id: string; name?: string | null; artist?: string | null; album?: string | null };
    const trackId = req.body?.trackId;
    if (trackId && typeof trackId === 'string') {
      // Subsonic first (carries albumId/artistId), library-db fallback.
      let song: any = null;
      try { song = await subsonic.getSong(trackId); } catch {}
      if (!song) {
        const row = db.getTrack(trackId);
        if (row && type === 'track') song = { id: row.id, title: row.title, artist: row.artist, album: row.album };
      }
      if (!song) return res.status(404).json({ error: 'track not found' });
      if (type === 'track') {
        input = { type, id: song.id, name: song.title ?? null, artist: song.artist ?? null, album: song.album ?? null };
      } else if (type === 'album') {
        if (!song.albumId) return res.status(404).json({ error: 'album not resolvable for this track' });
        input = { type, id: song.albumId, name: song.album ?? null, artist: song.artist ?? null };
      } else {
        if (!song.artistId) return res.status(404).json({ error: 'artist not resolvable for this track' });
        input = { type, id: song.artistId, name: song.artist ?? null };
      }
    } else {
      const id = req.body?.id;
      if (!id || typeof id !== 'string') return res.status(400).json({ error: 'trackId or id is required' });
      input = { type, id, name: req.body?.name ?? null, artist: req.body?.artist ?? null, album: req.body?.album ?? null };
    }

    const entry = await blocklist.add(input);
    if (!entry) return res.status(409).json({ error: 'already blocked' });

    queue.log('blocked', `${entry.type} "${entry.name ?? entry.id}"${entry.artist && entry.type !== 'artist' ? ` — ${entry.artist}` : ''} added to the never-play blocklist`);
    // Rebuild auto.m3u too, or a blocked track still airs from it for up to
    // autoQueueRefreshMinutes.
    const purged = queue.purgeBlocked();
    refreshAutoPlaylist().catch((err: any) => queue.log('error', `blocklist auto-playlist refresh failed: ${err.message}`));

    res.status(201).json({ entry, purged });
  } catch (err) {
    queue.log('error', `/library/blocklist failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
  },
);

router.delete('/library/blocklist/:type/:id', requireAdmin, async (req, res) => {
  const { type, id } = req.params;
  if (!['track', 'album', 'artist'].includes(type)) {
    return res.status(400).json({ error: "type must be 'track', 'album' or 'artist'" });
  }
  try {
    const removed = await blocklist.remove(type as blocklist.BlockType, id);
    if (!removed) return res.status(404).json({ error: 'not on the blocklist' });
    queue.log('blocked', `${type} ${id} removed from the never-play blocklist`);
    res.status(204).end();
  } catch (err) {
    queue.log('error', `/library/blocklist delete failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Bulk unblock: one rewrite and one persist, since N concurrent single DELETEs
// would race on the async write. Reports removed + missing.
const BULK_UNBLOCK_MAX = 500;

router.delete('/library/blocklist', requireAdmin, async (req, res) => {
  const raw = req.body?.entries;
  if (!Array.isArray(raw) || raw.length === 0) {
    return res.status(400).json({ error: 'entries must be a non-empty array of { type, id }' });
  }
  if (raw.length > BULK_UNBLOCK_MAX) {
    return res.status(400).json({ error: `at most ${BULK_UNBLOCK_MAX} entries per call` });
  }
  const targets: Array<{ type: blocklist.BlockType; id: string }> = [];
  for (const e of raw) {
    const type = e?.type;
    const id = e?.id;
    if (!['track', 'album', 'artist'].includes(type) || typeof id !== 'string' || !id) {
      return res.status(400).json({ error: 'each entry needs a valid type and id' });
    }
    targets.push({ type, id });
  }
  try {
    const { removed, missing } = await blocklist.removeMany(targets);
    if (removed) {
      queue.log('blocked', `${removed} entr${removed === 1 ? 'y' : 'ies'} removed from the never-play blocklist`);
    }
    res.json({ removed, missing });
  } catch (err) {
    queue.log('error', `/library/blocklist bulk delete failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Re-marks rows already on screen; matching client-side would duplicate the
// normalised-name rules in music/blocklist.ts.
const BLOCK_CHECK_MAX = 500;

router.post('/library/blocklist/check', requireAdmin, (req, res) => {
  const rows = req.body?.tracks;
  if (!Array.isArray(rows)) {
    return res.status(400).json({ error: 'tracks must be an array' });
  }
  if (rows.length > BLOCK_CHECK_MAX) {
    return res.status(400).json({ error: `at most ${BLOCK_CHECK_MAX} tracks per call` });
  }
  const blocked: Record<string, blocklist.BlockRef | null> = {};
  for (const row of rows) {
    const id = row?.id;
    if (typeof id !== 'string' || !id) continue;
    // hitOf covers rules too: tag fields absent from the slim payload resolve
    // through the library lookup inside the show-filter readers.
    blocked[id] = blocklist.hitOf(row);
  }
  res.json({ blocked });
});
