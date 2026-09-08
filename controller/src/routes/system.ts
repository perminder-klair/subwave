// Admin-gated GET /system — per-container CPU/memory plus host totals from the
// Docker Engine API. Fails open: with no Docker socket the body is 200 with
// dockerAvailable:false and host figures only.
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
