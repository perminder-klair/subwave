// Admin-gated health/control surface for the live community catalog fetched
// from the `community` repo (see community/registry.ts). Browse + install live
// with their domains (routes/dj.ts, personas.ts, shows.ts).

import express from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { queue } from '../broadcast/queue.js';
import { catalogStatus, refreshCatalog } from '../community/registry.js';

export const router = express.Router();

router.get('/community/status', requireAdmin, (req, res) => {
  res.json(catalogStatus());
});

// Busts the in-memory memo. The registry swallows fetch failures, so a failed
// refetch is a 200 status object with ok:false, not a 5xx.
router.post('/community/refresh', requireAdmin, async (req, res) => {
  try {
    const status = await refreshCatalog();
    res.json(status);
  } catch (err: any) {
    queue.log('error', `POST /community/refresh failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});
