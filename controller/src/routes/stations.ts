// Multi-station profile management (spec §4/§5). Offline stations are inert:
// list / rename / delete / make-live only — editing one means switching to it.

import { readFileSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { STATE_ROOT } from '../config.js';
import { MAX_STATIONS } from '../stations/pure.js';
import * as settings from '../settings.js';
import * as manager from '../stations/manager.js';
import * as libraryDb from '../music/library-db.js';
import { restartLiquidsoap } from '../broadcast/liquidsoap-control.js';

export const router = express.Router();

// A switch whose mixer restart never landed is a SPLIT-BRAIN: broadcast keeps
// serving the previous station's dir while this controller reboots into the
// new one — and the admin UI reports success (the /state poll only watches
// the controller). The old process can't warn anyone (it's about to exit), so
// it leaves this marker and the NEXT boot logs it loudly, right where the
// operator is looking after a switch.
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
  // no marker — the normal case
}

// The switch: pointer already written → bounce the mixer (its container
// entrypoint re-resolves + re-renders icecast on restart), then exit so the
// compose restart policy boots this process against the new station dir.
// setImmediate so the HTTP response flushes first.
function scheduleSwitchExit(): void {
  setImmediate(async () => {
    // Retry transient telnet failures before giving up — the mixer restart is
    // what moves broadcast onto the new station dir (see MIXER_FAIL_MARKER).
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
            // best-effort — the console.error above is the fallback trail
          }
        }
      }
    }
    console.log('[stations] exiting for station switch — supervisor restarts us');
    // Dev runs under `tsx watch`, which does NOT respawn a cleanly-exited
    // child — and the watch parent keeps the container alive, so docker's
    // restart policy never fires either. Bump this module's own mtime so the
    // watcher relaunches the server against the new pointer; the watcher's
    // debounce fires after exit(0) below, so the port is already free. Prod
    // (PID-1 node + restart policy) needs none of this and is gated out.
    if (process.env.NODE_ENV !== 'production') {
      try {
        const now = new Date();
        utimesSync(fileURLToPath(import.meta.url), now, now);
      } catch {
        // best-effort — worst case is the documented manual restart
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
