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
  type ListenerConnection,
} from '../broadcast/listeners.js';
import { hlsConnections } from '../broadcast/hls-listeners.js';
import { currentTrustedProxies } from '../broadcast/trusted-proxies.js';

export const router = express.Router();

router.get('/listeners', requireAdmin, async (req, res) => {
  try {
    // Caps at one week: past that the JSONL is too big to parse in-memory.
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

// Live per-listener detail: Icecast's admin interface plus the HLS rows the
// edge's playlist log yields. 502 on an Icecast auth/transport failure, so the
// UI can tell "nobody listening" (200, empty) from "couldn't reach Icecast
// admin" — but only when there is nothing else to show, since an HLS listener
// is present whether or not Icecast's admin socket answers.
router.get('/listeners/connections', requireAdmin, async (_req, res) => {
  // Reads a cached file, never a socket: it cannot fail the request.
  const hls = hlsConnections();
  let icecast: ListenerConnection[] = [];
  let icecastError: string | null = null;
  try {
    // Group by IP+UA (same dedup as the headline count), deliberately NOT by IP
    // alone: the forwarded address may be untrusted and one NAT is many listeners.
    icecast = groupConnections(await getConnections());
  } catch (err: any) {
    icecastError = err.message;
    if (hls.length === 0) {
      res.status(502).json({ error: err.message });
      return;
    }
  }
  const connections = [...icecast, ...hls];
  // What the icecast render trusted (#1613), so the UI can explain rows that
  // are all the edge's address. Advisory — it gates nothing.
  res.json({
    count: connections.length,
    connections,
    trustedProxies: currentTrustedProxies(),
    ...(icecastError ? { icecastError } : {}),
  });
});
