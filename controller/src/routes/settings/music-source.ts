// Admin → Settings → Music source (#692): choose between the direct Navidrome
// connection and the SUB/WAVE music router, pick and configure the router's
// source plugins, test a draft, and rescan installed plugins.
//
// The router owns the plugin inventory (manifests, load errors, health); this
// module validates a draft against those manifests before anything is saved,
// so a save cannot strand the station on a source that is missing settings.

import express from 'express';
import { requireAdmin } from '../../middleware/auth.js';
import { loadSetupConfig } from '../../setup/config.js';
import {
  ROUTER_URL,
  RouterUnavailableError,
  keepStoredSecrets,
  maskSelection,
  readSelection,
  routerReload,
  routerStatus,
  routerTest,
} from '../../setup/music-source.js';
import { applySelection, prepareSelection } from '../../setup/music-source-save.js';
import { firstMessage } from '../../util/zod-error.js';
import { musicSourceTestSchema, type RouterStatus } from '../../schemas/music-source.js';

export const router = express.Router();

async function statusOrError(): Promise<{ status: RouterStatus | null; error: string | null }> {
  try {
    return { status: await routerStatus(), error: null };
  } catch (err: any) {
    return { status: null, error: err?.message || 'router unreachable' };
  }
}

router.get('/settings/music-source', requireAdmin, async (_req, res) => {
  const sc = await loadSetupConfig();
  const selection = readSelection(sc);
  const { status, error } = await statusOrError();
  res.json({
    ...maskSelection(selection, status?.plugins ?? []),
    routerUrl: ROUTER_URL,
    router: status,
    routerError: error,
  });
});

router.post('/settings/music-source', requireAdmin, async (req, res) => {
  try {
    const sc = await loadSetupConfig();
    const prev = readSelection(sc);
    const prepared = await prepareSelection(req.body, prev);
    if (!prepared.ok) return res.status(prepared.code).json({ ok: false, error: prepared.error });
    const plugins = prepared.status?.plugins ?? (await statusOrError()).status?.plugins ?? [];
    const result = await applySelection(prepared.selection, prev, plugins);
    res.json({
      ok: !result.routerError,
      ...(result.routerError ? { error: result.routerError } : {}),
      switched: result.switched,
      reconcile: result.reconcile,
      // A refused save changed nothing, so it reports what is still stored.
      ...maskSelection(result.routerError ? prev : prepared.selection, plugins),
      router: result.router,
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || 'save failed' });
  }
});

// Test a draft without saving it. Blank secrets fall back to the stored ones
// for the same server, so Test works on a saved source without re-typing its
// API key — and never sends that key to a server it was not stored for.
router.post('/settings/music-source/test', requireAdmin, async (req, res) => {
  const parsed = musicSourceTestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, state: 'error', error: firstMessage(parsed.error) });
  try {
    const prev = readSelection(await loadSetupConfig());
    const status = await routerStatus();
    const [entry] = keepStoredSecrets([parsed.data], prev.sources, status.plugins);
    res.json(await routerTest(entry!));
  } catch (err: any) {
    const code = err instanceof RouterUnavailableError ? 503 : 500;
    res.status(code).json({ ok: false, state: 'error', error: err?.message || 'test failed' });
  }
});

// Pick up plugins dropped into state/router/plugins/ (or edited) without a restart.
router.post('/settings/music-source/rescan', requireAdmin, async (_req, res) => {
  try {
    const status = await routerReload();
    res.json({ ok: true, router: status });
  } catch (err: any) {
    res.status(503).json({ ok: false, error: err?.message || 'the music router is not reachable' });
  }
});
