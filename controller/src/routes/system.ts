// Admin-gated GET /system — per-container CPU/memory for the SUB/WAVE stack plus
// host totals, read from the Docker Engine API (see ../system.ts). Always 200:
// when the Docker socket isn't mounted the body carries dockerAvailable:false
// and just the host figures, so the Stats page can show "container stats
// unavailable" without treating it as a controller error.
import express from 'express';
import { requireAdmin } from '../middleware/auth.js';
import * as system from '../system.js';

export const router = express.Router();

router.get('/system', requireAdmin, async (_req, res) => {
  try {
    res.json(await system.summary());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
