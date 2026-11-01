// GET /stem-cache/usage: the stem cache's STORED size beside the budget
// in force, for the Settings budget field's "cache used" line and its warning
// when a new budget would make the next sweep delete stems.
//
// Admin-only. Reads the usage snapshot and never walks the cache
// (`stemCache.storedUsage()`); `usage` is null until a sweep or an analysis
// pass has measured it once.

import { Router } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import * as stemCache from '../music/stem-cache.js';

export const router = Router();

router.get('/stem-cache/usage', requireAdmin, async (_req, res) => {
  let usage: stemCache.StoredUsage | null = null;
  try { usage = await stemCache.storedUsage(); } catch { /* reported as unmeasured */ }
  res.json({ usage, budgetBytes: stemCache.budgetBytes() });
});
