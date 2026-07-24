// Multi-station profile management (spec §4/§5). Offline stations are inert:
// list / rename / delete / make-live only — editing one means switching to it.

import express from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { STATE_ROOT } from '../config.js';
import * as settings from '../settings.js';
import * as manager from '../stations/manager.js';
import * as libraryDb from '../music/library-db.js';
import { restartLiquidsoap } from '../broadcast/liquidsoap-control.js';

export const router = express.Router();

// The switch: pointer already written → bounce the mixer (its container
// entrypoint re-resolves + re-renders icecast on restart), then exit so the
// compose restart policy boots this process against the new station dir.
// setImmediate so the HTTP response flushes first.
function scheduleSwitchExit(): void {
  setImmediate(async () => {
    try {
      await restartLiquidsoap();
    } catch (err) {
      console.error('[stations] mixer restart failed:', (err as Error).message);
    }
    console.log('[stations] exiting for station switch — supervisor restarts us');
    process.exit(0);
  });
}

const currentName = () => settings.get()?.station || 'SUB/WAVE';

router.get('/stations', requireAdmin, (req, res) => {
  try {
    res.json({
      multiStation: manager.isMultiStation(STATE_ROOT),
      activeId: manager.activeIdOnDisk(STATE_ROOT),
      stations: manager.listStations(STATE_ROOT, currentName()),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post('/stations', requireAdmin, async (req, res) => {
  try {
    const { name, mode } = req.body || {};
    const { id, converted } = await manager.createStation(STATE_ROOT, {
      name: String(name || ''),
      mode: mode === 'duplicate' ? 'duplicate' : 'fresh',
      currentName: currentName(),
      // Fresh installs may never have opened library.db — a duplicate without
      // the analysis cache is still a valid station, so tolerate failure.
      backupLibraryDb: async (dest) => {
        try {
          await libraryDb.backup(dest);
        } catch (err) {
          console.warn('[stations] library.db copy skipped:', (err as Error).message);
        }
      },
    });
    // Conversion moved the running station's files under stations/main — this
    // process is now reading a stale root and must restart (spec §6).
    res.status(converted ? 202 : 201).json({ ok: true, id, converted, switching: converted });
    if (converted) scheduleSwitchExit();
  } catch (err) {
    // A StationCreateError with converted:true means the legacy-root
    // conversion completed before something afterward failed — that
    // conversion is durable (pointer + stations/main already on disk), so the
    // restart must happen regardless of this create() failing, or the
    // running process keeps writing into the now-stale root forever.
    if (err instanceof manager.StationCreateError && err.converted) {
      res.status(500).json({ error: err.message, converted: true, switching: true });
      scheduleSwitchExit();
      return;
    }
    res.status(400).json({ error: (err as Error).message });
  }
});

router.patch('/stations/:id', requireAdmin, (req, res) => {
  try {
    manager.renameStation(STATE_ROOT, String(req.params.id), String(req.body?.name || ''));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.delete('/stations/:id', requireAdmin, (req, res) => {
  try {
    manager.deleteStation(STATE_ROOT, String(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.post('/stations/:id/activate', requireAdmin, (req, res) => {
  try {
    const id = String(req.params.id);
    manager.activateStation(STATE_ROOT, id);
    res.status(202).json({ ok: true, switching: true, activeId: id });
    scheduleSwitchExit();
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});
