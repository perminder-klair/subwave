// Orphan stem-dir purge, operator surface.
//
// GET  /stems/orphans        dry-run report (never touches the disk)
// POST /stems/orphans        {confirm: true} runs the purge for real;
//                            {setEnabled: true|false} flips the daily cron.
//
// Manual triggers are exempt from every automatic gate (an explicit press
// always acts), but NOT from the purge's own safety rules: unconfirmed stays a
// dry run here too, and the empty-id-set / offline refusals are the module's,
// reported verbatim. requireAdmin, like every operator surface.

import { Router } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { allTrackIdsOrdered } from '../music/library-db.js';
import { runOrphanPurge } from '../music/orphan-purge.js';
import {
  listOrphanDirNames,
  listQuarantineDirNames,
  resolveOrphanNames,
} from '../music/orphan-names.js';
import * as settings from '../settings.js';

export const router = Router();

router.get('/stems/orphans', requireAdmin, async (_req, res) => {
  try {
    const report = await runOrphanPurge({ knownIds: allTrackIdsOrdered(), confirm: false });
    res.json({ enabled: settings.get()?.audio?.stemOrphanPurgeEnabled === true, report });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// The readable list behind the panel's button: every orphan dir (and every
// quarantine entry, flagged) with title/artist/album resolved from the
// sidecar → library/plays → recent-plays → event logs. Unresolvable ids still
// appear with null names — they are still disk to reclaim.
router.get('/stems/orphans/tracks', requireAdmin, async (_req, res) => {
  try {
    const known = new Set(allTrackIdsOrdered());
    const [orphanIds, quarantineIds] = await Promise.all([listOrphanDirNames(known), listQuarantineDirNames()]);
    const names = await resolveOrphanNames([...orphanIds, ...quarantineIds]);
    const row = (id: string, state: 'orphan' | 'quarantined') => {
      const n = names.get(id);
      return { id, state, title: n?.title ?? null, artist: n?.artist ?? null, album: n?.album ?? null };
    };
    const tracks = [...orphanIds.map(id => row(id, 'orphan')), ...quarantineIds.map(id => row(id, 'quarantined'))];
    tracks.sort((a, b) => (a.title ?? '\uffff').localeCompare(b.title ?? '\uffff') || a.id.localeCompare(b.id));
    res.json({ tracks });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post('/stems/orphans', requireAdmin, async (req, res) => {
  const body = (req.body ?? {}) as { confirm?: unknown; setEnabled?: unknown };
  try {
    if (typeof body.setEnabled === 'boolean') {
      await settings.update({ audio: { stemOrphanPurgeEnabled: body.setEnabled } });
    }
    const confirm = body.confirm === true;
    const report = await runOrphanPurge({
      knownIds: allTrackIdsOrdered(),
      confirm,
      // Only reached on a confirmed pass that will move something; stamps the
      // resolved names into each quarantine before the logs age them out.
      ...(confirm ? { resolveNames: (ids: string[]) => resolveOrphanNames(ids) } : {}),
    });
    res.json({ enabled: settings.get()?.audio?.stemOrphanPurgeEnabled === true, report });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
