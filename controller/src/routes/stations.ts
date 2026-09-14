// Multi-station profile management (spec §4/§5). Offline stations are inert:
// list / rename / delete / make-live only — editing one means switching to it.

import { readFileSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { stationCreateSchema, stationRenameSchema, type StationCreate } from '../schemas/station.js';
import { STATE_ROOT } from '../config.js';
import { envHasNavidrome } from '../setup/firstRun.js';
import { MAX_STATIONS } from '../stations/pure.js';
import * as settings from '../settings.js';
import * as manager from '../stations/manager.js';
import * as libraryDb from '../music/library-db.js';
import { restartLiquidsoap } from '../broadcast/liquidsoap-control.js';

export const router = express.Router();

// A switch whose mixer restart never landed is a split brain: broadcast keeps
// serving the previous station's dir. The exiting process can't warn anyone, so
// it drops this marker and the next boot logs it.
const MIXER_FAIL_MARKER = join(STATE_ROOT, 'stations', 'mixer-restart-failed.json');
try {
  const m = JSON.parse(readFileSync(MIXER_FAIL_MARKER, 'utf8')) as { at?: string; error?: string };
  console.error(
    `[stations] WARNING: the station switch at ${m.at} could not restart the mixer (${m.error}). ` +
    'Broadcast may still be playing the PREVIOUS station — restart it manually: ' +
    'docker compose restart broadcast',
  );
  unlinkSync(MIXER_FAIL_MARKER); // warn once, on the boot right after the failed switch
} catch {
  // no marker: the normal case
}

// Pointer is already written: bounce the mixer (its entrypoint re-renders icecast
// on restart), then exit so the supervisor boots us against the new station dir.
// setImmediate so the HTTP response flushes first.
function scheduleSwitchExit(): void {
  setImmediate(async () => {
    // The mixer restart is what moves broadcast onto the new station dir.
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await restartLiquidsoap();
        break;
      } catch (err) {
        console.error(
          `[stations] mixer restart failed (attempt ${attempt}/3):`,
          (err as Error).message,
        );
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 2000));
        } else {
          try {
            writeFileSync(MIXER_FAIL_MARKER, JSON.stringify({
              at: new Date().toISOString(),
              error: (err as Error).message,
            }));
          } catch {
            // best-effort; console.error above is the fallback trail
          }
        }
      }
    }
    console.log('[stations] exiting for station switch — supervisor restarts us');
    // `tsx watch` does not respawn a cleanly-exited child and keeps the container
    // alive, so bump this module's mtime to make the watcher relaunch us. Prod
    // (PID-1 node + restart policy) needs none of this.
    if (process.env.NODE_ENV !== 'production') {
      try {
        const now = new Date();
        utimesSync(fileURLToPath(import.meta.url), now, now);
      } catch {
        // best-effort; worst case is a manual restart
      }
    }
    process.exit(0);
  });
}

const currentName = () => settings.get()?.station || 'SUB/WAVE';

router.get('/stations', requireAdmin, (req, res) => {
  try {
    res.json({
      multiStation: manager.isMultiStation(STATE_ROOT),
      activeId: manager.activeIdOnDisk(STATE_ROOT),
      limit: MAX_STATIONS,
      stations: manager.listStations(STATE_ROOT, currentName(), envHasNavidrome()),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// createStation runs the same schema again as the chokepoint, since it is
// reachable without this route.
router.post('/stations', requireAdmin, validateBody(stationCreateSchema), async (req, res) => {
  try {
    const { name, mode } = req.body as StationCreate;
    const { id, converted } = await manager.createStation(STATE_ROOT, {
      name,
      mode,
      currentName: currentName(),
      // A duplicate without the analysis cache is still a valid station.
      backupLibraryDb: async (dest) => {
        try {
          await libraryDb.backup(dest);
        } catch (err) {
          console.warn('[stations] library.db copy skipped:', (err as Error).message);
        }
      },
    });
    // Conversion moved this station's files under stations/main, so the process
    // is now reading a stale root and must restart.
    res.status(converted ? 202 : 201).json({ ok: true, id, converted, switching: converted });
    if (converted) scheduleSwitchExit();
  } catch (err) {
    // converted:true means the legacy-root conversion is already durable on disk,
    // so the restart must happen even though create() failed; otherwise this
    // process keeps writing into the stale root. `field` rides the same
    // fieldErrors contract validateBody emits.
    const field = err instanceof manager.StationCreateError ? err.field : undefined;
    const fieldErrors = field ? { [field]: (err as Error).message } : undefined;
    if (err instanceof manager.StationCreateError && err.converted) {
      res.status(500).json({
        error: err.message, fieldErrors, converted: true, switching: true,
      });
      scheduleSwitchExit();
      return;
    }
    res.status(400).json({ error: (err as Error).message, fieldErrors });
  }
});

router.patch('/stations/:id', requireAdmin, validateBody(stationRenameSchema), async (req, res) => {
  try {
    const id = String(req.params.id);
    const resolved = manager.renameStation(STATE_ROOT, id, String(req.body.name));
    // The active station's settings live in the running process too, and
    // update() rewrites settings.json from memory, so renameStation's fs patch
    // alone would be overwritten.
    let requiresRestart = false;
    if (manager.activeIdOnDisk(STATE_ROOT) === id) {
      ({ requiresRestart } = await settings.update({ station: resolved }));
    }
    res.json({ ok: true, requiresRestart });
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
