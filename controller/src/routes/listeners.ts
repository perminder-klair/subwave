// Admin-gated GET /listeners — recent listener-count time-series, persisted
// by broadcast/listeners.ts. Feeds the admin sparkline.
import express from 'express';
import { requireAdmin } from '../middleware/auth.js';
import {
  history,
  historyBytes,
  getListenerCount,
  getConnections,
  groupConnections,
} from '../broadcast/listeners.js';
import { currentTrustedProxies } from '../broadcast/trusted-proxies.js';

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
    // Group by IP+UA so Safari's duplicate socket is one row + one count, not
    // two — same dedup the headline listener count uses. Deliberately NOT by
    // IP: the forwarded address may be untrusted, and one NAT is many
    // listeners. Nothing below changes that.
    const connections = groupConnections(await getConnections());
    // What the icecast render trusted (#1613), on the SAME response that
    // carries the rows: a BYO stack has no `caddy` name to resolve, so every
    // row is the edge's container address and the operator's only clue used to
    // be a line in the broadcast container's log. Advisory — it gates nothing.
    res.json({
      count: connections.length,
      connections,
      trustedProxies: currentTrustedProxies(),
    });
  } catch (err: any) {
    res.status(502).json({ error: err.message });
  }
});
