// Setup overlay — small JSON file the first-run wizard writes to capture
// Navidrome credentials and the setup-complete timestamp. Lives at
// state/setup-config.json (writable from any container UID via the existing
// state-dir perms). Multi-station profiles use only their own stored connection;
// single-station installs still let environment variables override it.
//
// Why not extend settings.ts? Settings.ts has thick schema validation for the
// admin UI's many knobs (DJ personas, shows, schedules, TTS engines, …). The
// wizard only needs a tiny structured store for fields that already had env-var
// counterparts. A separate file keeps the surfaces clean: settings.ts stays
// the runtime admin store; setup-config.json holds the music connection.

import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { NAVIDROME_PROFILE_POLICY, navidromeEnvLocks, resolveNavidrome } from './navidrome-policy.js';
import {
  currentSelection,
  noteStationNavidrome,
  readRouterAuth,
  readSelection,
  routerConnection,
  routerServing,
  setCurrentSelection,
  writeRouterConfig,
  type RouterAuth,
} from './music-source.js';
import { isStationNavidromeOnly } from '../schemas/music-source.js';
import { config, STATE_DIR, NAVIDROME_ENV_ENABLED } from '../config.js';
import { writeFileAtomic } from '../util/atomic-file.js';

const PATH = `${STATE_DIR}/setup-config.json`;

export interface SetupConfig {
  navidrome?: {
    url?: string;
    user?: string;
    pass?: string;
  };
  // Music-source selection (#692): the music router or direct Navidrome.
  // Absent = the router serving this Navidrome. Shape: schemas/music-source.ts.
  music?: unknown;
  // ISO timestamp written when the wizard saves successfully.
  setupCompletedAt?: string;
  navidromePolicy?: typeof NAVIDROME_PROFILE_POLICY;
}

// No in-process cache: the file is ~200 bytes and only read on the rare
// /onboarding/status path (admin shell mount, onboarding page load). A
// cache here previously caused a real bug — when the CLI's `subwave setup`
// wrote the file from the host side, the controller kept serving its stale
// empty snapshot and AdminShell kept bouncing the operator back to
// /onboarding even though setup was complete.
export async function loadSetupConfig(): Promise<SetupConfig> {
  if (!existsSync(PATH)) return {};
  try {
    return JSON.parse(await readFile(PATH, 'utf8'));
  } catch {
    return {};
  }
}

export async function saveSetupConfig(patch: Partial<SetupConfig>): Promise<SetupConfig> {
  const current = await loadSetupConfig();
  // Shallow-merge top level, deep-merge navidrome to allow partial updates.
  const next: SetupConfig = {
    ...current,
    ...patch,
    navidrome: { ...(current.navidrome || {}), ...(patch.navidrome || {}) },
    ...(!NAVIDROME_ENV_ENABLED && patch.navidrome ? { navidromePolicy: NAVIDROME_PROFILE_POLICY } : {}),
  };
  await mkdir(dirname(PATH), { recursive: true });
  await writeFileAtomic(PATH, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

// Used by the controller and both maintenance entrypoints. In router mode the
// live connection is the music router (setup/music-source.ts); the stored
// Navidrome credentials stay in the file for switching back.
export async function loadNavidromeConfig(): Promise<void> {
  const sc = await loadSetupConfig();
  const selection = readSelection(sc);
  const nav = resolveNavidrome(sc.navidrome, NAVIDROME_ENV_ENABLED);
  setCurrentSelection(selection);
  noteStationNavidrome(nav);
  Object.assign(config.navidrome, selection.mode === 'router' ? routerConnection(readRouterAuth()) : nav);
}

/**
 * Maintenance runs (the tagger's walk, analysis): load the connection, and take
 * the failover's decision once. They read the router like the controller, but
 * a run started while it is down would fail outright though the station plays
 * on, failed over — so when the station plays its Navidrome alone and the
 * router is not serving, this run reads that Navidrome directly (the same
 * ids). The main process re-decides every tick: music/source-failover.ts.
 */
export async function loadMaintenanceConnection(): Promise<void> {
  await loadNavidromeConfig();
  if (!isStationNavidromeOnly(currentSelection())) return;
  const router = await routerServing();
  if (router.ok) return;
  const nav = await storedNavidrome();
  if (!nav.url || !nav.user || !nav.password) return;
  // Imported here: the Subsonic client is heavy, and only this branch needs it.
  const { pingWith } = await import('../music/subsonic.js');
  if (!(await pingWith({ url: nav.url, user: nav.user, pass: nav.password, client: 'sub-wave-maintenance' })).ok) return;
  Object.assign(config.navidrome, { url: nav.url, user: nav.user, password: nav.password });
  console.warn(`[music-source] music router not serving (${router.reason}) — this run reads Navidrome directly`);
}

/**
 * Rewrite the router's config.json from what is stored: the selection, and the
 * station's Navidrome connection the navidrome source plays. Boot and every
 * save of that connection; main controller process only.
 */
export async function syncRouterConfig(): Promise<RouterAuth> {
  const sc = await loadSetupConfig();
  const nav = resolveNavidrome(sc.navidrome, NAVIDROME_ENV_ENABLED);
  noteStationNavidrome(nav);
  return writeRouterConfig(readSelection(sc), nav);
}

// The direct Navidrome connection as stored (env applied), whichever music
// mode is live. In navidrome mode it equals config.navidrome; in router mode
// config.navidrome is the ROUTER, which must never be saved or shown as the
// station's Navidrome (settings, multi-station conversion).
export async function storedNavidrome(): Promise<{ url: string; user: string; password: string }> {
  if (currentSelection().mode !== 'router') return config.navidrome;
  return resolveNavidrome((await loadSetupConfig()).navidrome, NAVIDROME_ENV_ENABLED);
}

/** The stored connection for the admin UI: the password never leaves the process, and env locks are per field. */
export async function storedNavidromeView(): Promise<{ url: string; user: string; passSet: boolean; env: ReturnType<typeof navidromeEnvLocks> }> {
  const nv = await storedNavidrome();
  return { url: nv.url, user: nv.user, passSet: !!nv.password, env: navidromeEnvLocks(NAVIDROME_ENV_ENABLED) };
}

// Kept for callers that previously invalidated the (now-removed) cache.
// No-op — every read is fresh from disk.
export function clearSetupConfigCache() {}

// Apply freshly-saved Navidrome creds to the LIVE config so Subsonic calls use
// them without a restart. Shared by the onboarding wizard's save and the admin
// Settings Music-source save — one place, so live-apply behaviour can't drift.
// Blank/absent fields keep their current live value (partial updates are fine,
// and a blank password can never clobber a working live one).
export function applyNavidromeToLiveConfig(nv: { url?: string; user?: string; pass?: string }) {
  if (nv.url) config.navidrome.url = String(nv.url).trim().replace(/\/$/, '');
  if (nv.user) config.navidrome.user = String(nv.user).trim();
  if (nv.pass) config.navidrome.password = String(nv.pass);
}
