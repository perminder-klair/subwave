// Admin-gated diagnostics + manual refresh for the live community catalog
// (skills / personas / shows / stations) fetched from the `subwave-community`
// repo — see community/registry.ts. The browse + install routes live with their
// domains (routes/dj.ts for skills, routes/personas.ts, routes/shows.ts); this
// module is only the catalog's own health/control surface for the admin UI.

import express from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { queue } from '../broadcast/queue.js';
import { catalogStatus, refreshCatalog } from '../community/registry.js';

export const router = express.Router();

// GET /community/status — where the catalog is fetched from + freshness/health
// (last successful fetch, index build time, entry counts, last error). Operator
// diagnostics, so admin-gated.
router.get('/community/status', requireAdmin, (req, res) => {
  res.json(catalogStatus());
});

// POST /community/refresh — bust the in-memory memo and refetch now. Never
// throws (the registry swallows fetch failures), so a failed refetch returns a
// 200 status object with ok:false + the error, not a 5xx.
router.post('/community/refresh', requireAdmin, async (req, res) => {
  try {
    const status = await refreshCatalog();
    res.json(status);
  } catch (err: any) {
    queue.log('error', `POST /community/refresh failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});
