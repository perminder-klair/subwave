// Admin-gated GET /listeners — recent listener-count time-series, persisted
// by broadcast/listeners.ts. Feeds the admin sparkline.
import express from 'express';
import { requireAdmin } from '../middleware/auth.js';
import {
  history,
  historyBytes,
  getListenerCount,
  getConnections,
} from '../broadcast/listeners.js';

export const router = express.Router();

router.get('/listeners', requireAdmin, async (req, res) => {
  try {
    // sinceMinutes caps at one week — past that the JSONL gets too big to
    // parse in-memory comfortably, and the sparkline isn't useful at that
    // resolution anyway.
    const sinceMinutes = Math.max(
      5,
      Math.min(parseInt(String(req.query.sinceMinutes ?? ''), 10) || 1440, 7 * 1440),
    );
    const since = new Date(Date.now() - sinceMinutes * 60 * 1000);
    const samples = await history({ since });
    const bytes = await historyBytes();
    res.json({
      current: getListenerCount(),
      sinceMinutes,
      bytes,
      samples,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Admin-gated GET /listeners/connections — live per-listener detail (IP,
// mount, user-agent, connected-for) read from Icecast's admin interface.
// Feeds the admin connections table. 502 on a real Icecast auth/transport
// failure so the UI can distinguish "nobody listening" (200, empty) from
// "couldn't reach Icecast admin".
router.get('/listeners/connections', requireAdmin, async (_req, res) => {
  try {
    const connections = await getConnections();
    res.json({ count: connections.length, connections });
  } catch (err: any) {
    res.status(502).json({ error: err.message });
  }
});
