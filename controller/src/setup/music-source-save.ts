// Saving a music-source selection (#692), shared by Admin → Settings → Music
// source and the onboarding wizard so both refuse the same drafts and apply a
// saved one the same way.

import { config, NAVIDROME_ENV_ENABLED } from '../config.js';
import { firstMessage } from '../util/zod-error.js';
import { clearNavidromeCache } from '../doctor.js';
import { clearPoolCache } from '../music/picker.js';
import { clearServerCaches } from '../music/subsonic.js';
import { refreshAutoPlaylist } from '../broadcast/scheduler.js';
import { queue } from '../broadcast/queue.js';
import { startReconcile, tagger } from '../broadcast/tagger.js';
import { resetFailover } from '../music/source-failover.js';
import { applyNavidromeToLiveConfig, loadSetupConfig, saveSetupConfig, syncRouterConfig } from './config.js';
import { resolveNavidrome } from './navidrome-policy.js';
import {
  currentSelection,
  keepStoredSecrets,
  keptSecretKeys,
  markSourceSwitch,
  navidromeComplete,
  noteStationNavidrome,
  readRouterAuth,
  routerConnection,
  routerReload,
  routerStatus,
  selectionIdentity,
  setCurrentSelection,
  writeRouterConfig,
} from './music-source.js';
import {
  STATION_NAVIDROME_PLUGIN,
  missingMusicFields,
  musicSelectionPatchSchema,
  usesStationNavidrome,
  type MusicSelection,
  type RouterStatus,
} from '../schemas/music-source.js';

const NAVIDROME_MISSING = 'Navidrome needs a server address, username and password — set the Navidrome connection first';

type NavidromeCredentials = { url?: string; user?: string; pass?: string };

/** The station's Navidrome connection, with credentials about to be saved in the same request laid over it. */
async function stationNavidrome(pending?: NavidromeCredentials) {
  const stored = (await loadSetupConfig()).navidrome ?? {};
  const typed = Object.fromEntries(Object.entries(pending ?? {}).filter(([, v]) => typeof v === 'string' && v.trim() !== ''));
  return resolveNavidrome({ ...stored, ...typed }, NAVIDROME_ENV_ENABLED);
}

/**
 * Validate a draft selection against the router's plugin manifests. Shared by
 * save (and the onboarding save) so both refuse the same things.
 */
export async function prepareSelection(
  body: unknown,
  prev: MusicSelection,
  /** Navidrome credentials the same request saves first (the onboarding wizard). */
  pendingNavidrome?: NavidromeCredentials,
): Promise<{ ok: true; selection: MusicSelection; status: RouterStatus | null } | { ok: false; code: number; error: string }> {
  const parsed = musicSelectionPatchSchema.safeParse(body);
  if (!parsed.success) return { ok: false, code: 400, error: firstMessage(parsed.error) };
  const draft = parsed.data;
  const nav = await stationNavidrome(pendingNavidrome);
  if (usesStationNavidrome(draft) && !navidromeComplete(nav)) return { ok: false, code: 400, error: NAVIDROME_MISSING };
  if (draft.mode === 'navidrome') {
    // Going direct keeps the router sources on file for next time.
    return { ok: true, selection: { mode: 'navidrome', merge: prev.merge, sources: prev.sources }, status: null };
  }
  let status: RouterStatus;
  try {
    status = await routerStatus();
  } catch (err: any) {
    return { ok: false, code: 503, error: err?.message || 'the music router is not reachable' };
  }
  const sources = draft.sources.map((s) =>
    s.plugin === STATION_NAVIDROME_PLUGIN
      ? // The station's Navidrome: its settings are the station connection, and
        // it keeps the ids the station already stores unless told otherwise.
        { ...s, config: {}, rawIds: s.rawIds ?? true }
      : s,
  );
  for (const entry of sources) {
    const plugin = status.plugins.find((p) => p.name === entry.plugin);
    if (!plugin) return { ok: false, code: 400, error: `no music-source plugin named '${entry.plugin}' is installed in the router` };
    if (plugin.error) return { ok: false, code: 400, error: `${plugin.label} cannot load: ${plugin.error}` };
    if (entry.plugin === STATION_NAVIDROME_PLUGIN) continue; // checked above, against the station connection
    const missing = missingMusicFields(entry, plugin, keptSecretKeys(entry, prev.sources, plugin));
    if (missing.length) {
      const labels = missing.map((k) => plugin.config.find((f) => f.key === k)?.label ?? k);
      return { ok: false, code: 400, error: `${plugin.label} needs: ${labels.join(', ')}` };
    }
  }
  return {
    ok: true,
    selection: { mode: 'router', merge: draft.merge, sources: keepStoredSecrets(sources, prev.sources, status.plugins) },
    status,
  };
}

/**
 * Persist a prepared selection and make it live: the router's config.json,
 * setup-config.json, the live Subsonic connection, and every cache that
 * described the previous library. Returns the router's view afterwards.
 *
 * The router goes first because it is the one step that can still refuse the
 * selection (a plugin that throws on start-up, a merge it rejects). A refusal
 * restores the router's previous config and returns before anything else is
 * touched, so the station keeps playing what it played and no switch marker
 * is left for a library that never went live.
 */
export async function applySelection(selection: MusicSelection, prev: MusicSelection, plugins: RouterStatus['plugins']): Promise<{
  router: RouterStatus | null;
  routerError: string | null;
  switched: boolean;
  /** started: the carry-across walk is running now; pending: it waits for the running tagger. */
  reconcile: 'started' | 'pending' | null;
}> {
  const nav = await stationNavidrome();
  const auth = await writeRouterConfig(selection, nav);

  let router: RouterStatus | null = null;
  let routerError: string | null = null;
  try {
    router = await routerReload();
    if (selection.mode === 'router' && router.configError) routerError = router.configError;
  } catch (err: any) {
    // In navidrome mode the router is optional; its absence is not an error.
    if (selection.mode === 'router') routerError = err?.message || 'router unreachable';
  }
  if (routerError) {
    await writeRouterConfig(prev, nav);
    // Best effort: the router also re-reads config.json on its own poll.
    router = await routerReload().catch(() => router);
    return { router, routerError, switched: false, reconcile: null };
  }

  await saveSetupConfig({ music: selection });
  setCurrentSelection(selection);
  noteStationNavidrome(nav);
  // The save applies its own connection; a failover in progress ends here and
  // the monitor re-decides from the new selection.
  resetFailover();
  Object.assign(config.navidrome, selection.mode === 'router' ? routerConnection(auth ?? readRouterAuth()) : nav);

  const from = selectionIdentity(prev, plugins);
  const to = selectionIdentity(selection, plugins);
  const switched = from !== to;
  if (switched) await markSourceSwitch(from, to);

  // Everything below described the previous library.
  clearServerCaches();
  clearNavidromeCache();
  clearPoolCache();
  queue.log('scheduler', `Music source → ${describe(selection, plugins)}`);
  // auto.m3u holds the previous backend's signed URLs; rebuild it now rather
  // than at the hourly refresh. Fire-and-forget so the save is not held up.
  refreshAutoPlaylist().catch((err) => queue.log('error', `Post-save playlist refresh failed: ${err.message}`));

  // Every track id just changed. A reconcile walk (no LLM) adopts library rows
  // by metadata under the switch marker, so tags, analysis, likes and the
  // blocklist follow the music now rather than whenever someone remembers to
  // press the button. Busy tagger: it walked the old library, so the reconcile
  // follows when it exits (broadcast/tagger.ts resumeSourceSwitch).
  let reconcile: 'started' | 'pending' | null = null;
  const healthy = selection.mode !== 'router' || (router?.active.length ? router.active.every((a) => a.health.state === 'healthy') : false);
  if (switched && healthy) {
    if (tagger.running) reconcile = 'pending';
    else {
      startReconcile();
      reconcile = 'started';
    }
  }
  return { router, routerError: null, switched, reconcile };
}

/**
 * The station's Navidrome connection was just saved (Admin → Music sources, the
 * wizard, the CLI): make it live wherever it plays. Direct mode applies it to
 * the Subsonic client; behind the router the navidrome source is rebuilt from
 * it. Shared by every writer of that connection so the live apply cannot drift.
 * Returns whether the station is now playing it.
 */
export async function applyNavidromeConnection(submitted: { url?: string; user?: string; pass?: string }): Promise<boolean> {
  const sel = currentSelection();
  if (sel.mode !== 'router') {
    applyNavidromeToLiveConfig(submitted);
    noteStationNavidrome(await stationNavidrome());
  } else {
    await syncRouterConfig();
    if (!usesStationNavidrome(sel)) return false;
    // Best effort: the router also notices the rewritten config.json on its own poll.
    await routerReload().catch(() => null);
  }
  clearServerCaches();
  clearNavidromeCache();
  clearPoolCache();
  return true;
}

function describe(sel: MusicSelection, plugins: RouterStatus['plugins']): string {
  if (sel.mode !== 'router') return 'Navidrome (direct)';
  const names = sel.sources.map((s) => plugins.find((p) => p.name === s.plugin)?.label ?? s.plugin);
  return `music router (${names.join(' + ')})`;
}

