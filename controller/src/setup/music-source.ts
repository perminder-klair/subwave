// Which backend the station's Subsonic client talks to (#692), and everything
// the controller owns about the SUB/WAVE music router.
//
// The selection lives in the station's setup-config.json (`music`). In
// `navidrome` mode — the default, and what an absent block means — nothing here
// changes behaviour. In `router` mode config.navidrome points at the router
// with credentials the controller generated, so every Subsonic call (and every
// stream URL handed to Liquidsoap and the analyzer) goes through the router
// and nothing downstream of music/subsonic.ts learns the difference.
//
// state/router/config.json is install-level and has exactly one writer: this
// module, in the main controller process (maintenance children only read it).
// It carries the router's credentials and the ACTIVE station's selection;
// switching stations restarts the controller, which rewrites it at boot.

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { STATE_DIR, STATE_ROOT } from '../config.js';
import { envUrl } from '../util/env.js';
import { writeFileAtomic } from '../util/atomic-file.js';
import {
  DEFAULT_MUSIC_SELECTION,
  musicSelectionSchema,
  routerStatusSchema,
  routerTestResultSchema,
  type MusicPluginInfo,
  type MusicSelection,
  type MusicSourceEntry,
  type RouterStatus,
  type RouterTestResult,
} from '../schemas/music-source.js';

/** Where the controller reaches the router; the compose service name by default, like navidrome.url. */
export const ROUTER_URL = envUrl('MUSIC_ROUTER_URL', 'http://router:4534');
export const ROUTER_DIR = path.join(STATE_ROOT, 'router');
export const ROUTER_CONFIG_PATH = path.join(ROUTER_DIR, 'config.json');
export const SOURCE_SWITCH_PATH = path.join(STATE_DIR, 'music-source-switch.json');

const ROUTER_USER = 'subwave';
const ROUTER_TIMEOUT_MS = 15_000;

export interface RouterAuth {
  user: string;
  pass: string;
}

// --- selection ----------------------------------------------------------------

/** The selection a setup-config.json carries; absent or damaged → direct Navidrome. */
export function readSelection(setupConfig: { music?: unknown } | null | undefined): MusicSelection {
  return musicSelectionSchema.parse(setupConfig?.music ?? DEFAULT_MUSIC_SELECTION);
}

// The live selection, for the synchronous readers (/state's needsSetup, the
// doctor's labels). Set at boot by loadNavidromeConfig and on every save.
let current: MusicSelection = DEFAULT_MUSIC_SELECTION;

export function currentSelection(): MusicSelection {
  return current;
}

export function setCurrentSelection(sel: MusicSelection): void {
  current = sel;
}

export function isRouterMode(sel: MusicSelection = current): boolean {
  return sel.mode === 'router';
}

/** A router-mode station is set up once it has a source to play from. */
export function routerSelectionComplete(sel: MusicSelection): boolean {
  return sel.mode === 'router' && sel.sources.length > 0;
}

// --- router credentials and config.json ---------------------------------------

export function readRouterAuth(): RouterAuth | null {
  try {
    const raw = JSON.parse(readFileSync(ROUTER_CONFIG_PATH, 'utf8'));
    const auth = raw?.auth;
    if (typeof auth?.user === 'string' && typeof auth?.pass === 'string' && auth.pass.length >= 16) {
      return { user: auth.user, pass: auth.pass };
    }
  } catch {
    /* absent or unreadable: generated on the next write */
  }
  return null;
}

function routerConfigFor(sel: MusicSelection, auth: RouterAuth) {
  return {
    version: 1,
    auth,
    merge: sel.merge,
    // Navidrome mode leaves the router idle: it keeps its credentials and
    // serves nothing, so switching back to router mode is a config write.
    sources: sel.mode === 'router' ? sel.sources : [],
  };
}

/**
 * Write state/router/config.json for this selection, generating the router's
 * credentials on first use (as the Icecast secrets are) and keeping them after.
 * Skips the write when nothing changed, so a boot does not touch the file the
 * router polls. Main controller process only.
 */
export async function writeRouterConfig(sel: MusicSelection): Promise<RouterAuth> {
  const auth = readRouterAuth() ?? { user: ROUTER_USER, pass: randomBytes(24).toString('hex') };
  const next = JSON.stringify(routerConfigFor(sel, auth), null, 2);
  let prev = '';
  try {
    prev = readFileSync(ROUTER_CONFIG_PATH, 'utf8');
  } catch {
    /* first write */
  }
  if (prev !== next) {
    await mkdir(ROUTER_DIR, { recursive: true });
    await mkdir(path.join(ROUTER_DIR, 'plugins'), { recursive: true }).catch(() => {});
    await writeFileAtomic(ROUTER_CONFIG_PATH, next, { mode: 0o600 });
  }
  return auth;
}

/** The connection music/subsonic.ts uses in router mode. */
export function routerConnection(auth: RouterAuth | null): { url: string; user: string; password: string } {
  return { url: ROUTER_URL, user: auth?.user ?? '', password: auth?.pass ?? '' };
}

// --- secrets in the browser ---------------------------------------------------

function secretKeys(plugin: Pick<MusicPluginInfo, 'config'> | undefined): string[] {
  return (plugin?.config ?? []).filter((f) => f.type === 'secret').map((f) => f.key);
}

export interface MaskedSourceEntry extends MusicSourceEntry {
  /** Secret keys that have a stored value; the values themselves never leave the process. */
  secretsSet: string[];
}

export function maskSelection(sel: MusicSelection, plugins: readonly MusicPluginInfo[]): { mode: MusicSelection['mode']; merge: boolean; sources: MaskedSourceEntry[] } {
  return {
    mode: sel.mode,
    merge: sel.merge,
    sources: sel.sources.map((entry) => {
      const plugin = plugins.find((p) => p.name === entry.plugin);
      // Without the manifest we cannot tell a secret from a URL, so nothing is shown.
      const secrets = plugin ? secretKeys(plugin) : Object.keys(entry.config);
      const config: MusicSourceEntry['config'] = {};
      const secretsSet: string[] = [];
      for (const [k, v] of Object.entries(entry.config)) {
        if (secrets.includes(k)) {
          if (v !== '' && v !== null) secretsSet.push(k);
        } else config[k] = v;
      }
      return { ...entry, config, secretsSet };
    }),
  };
}

/** A blank secret in a draft keeps the stored one for the same plugin. */
export function keepStoredSecrets(
  next: MusicSourceEntry[],
  prev: MusicSourceEntry[],
  plugins: readonly MusicPluginInfo[],
): MusicSourceEntry[] {
  return next.map((entry) => {
    const old = prev.find((p) => p.plugin === entry.plugin);
    if (!old) return entry;
    const config = { ...entry.config };
    for (const key of secretKeys(plugins.find((p) => p.name === entry.plugin))) {
      const v = config[key];
      if ((v === undefined || v === null || v === '') && old.config[key] !== undefined) config[key] = old.config[key];
    }
    return { ...entry, config };
  });
}

/** Secret keys a draft left blank that will fall back to a stored value. */
export function keptSecretKeys(entry: MusicSourceEntry, prev: MusicSourceEntry[], plugin: MusicPluginInfo | undefined): string[] {
  const old = prev.find((p) => p.plugin === entry.plugin);
  if (!old) return [];
  return secretKeys(plugin).filter((k) => {
    const v = entry.config[k];
    return (v === undefined || v === null || v === '') && old.config[k] !== undefined && old.config[k] !== '';
  });
}

// --- source switches ------------------------------------------------------------

/**
 * What decides the station's track ids: the mode and, in router mode, which
 * sources answer, how their ids are published, and where they point. Secrets
 * are excluded — a new password reaches the same library.
 */
export function selectionIdentity(sel: MusicSelection, plugins: readonly MusicPluginInfo[] = []): string {
  if (sel.mode !== 'router') return 'navidrome';
  return JSON.stringify(
    sel.sources.map((s) => {
      const secrets = secretKeys(plugins.find((p) => p.name === s.plugin));
      const visible = Object.fromEntries(Object.entries(s.config).filter(([k]) => !secrets.includes(k)).sort(([a], [b]) => a.localeCompare(b)));
      return { plugin: s.plugin, rawIds: s.rawIds === true, config: visible };
    }),
  );
}

/**
 * Record that track ids are about to change. The next complete library walk
 * reads this and carries tags, analysis, likes and the blocklist across by
 * matching tracks on their metadata (music/source-switch.ts).
 */
export async function markSourceSwitch(from: string, to: string): Promise<void> {
  await mkdir(path.dirname(SOURCE_SWITCH_PATH), { recursive: true });
  await writeFile(SOURCE_SWITCH_PATH, JSON.stringify({ version: 1, at: new Date().toISOString(), from, to }, null, 2));
}

// --- the router's internal API -------------------------------------------------

export class RouterUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RouterUnavailableError';
  }
}

async function routerFetch(route: string, init: RequestInit = {}): Promise<unknown> {
  const auth = readRouterAuth();
  if (!auth) throw new RouterUnavailableError('the music router has no credentials yet — the controller writes them at boot');
  let resp: Response;
  try {
    resp = await fetch(`${ROUTER_URL}/internal${route}`, {
      ...init,
      headers: {
        authorization: 'Basic ' + Buffer.from(`${auth.user}:${auth.pass}`).toString('base64'),
        'content-type': 'application/json',
      },
      signal: AbortSignal.timeout(ROUTER_TIMEOUT_MS),
    });
  } catch (err: any) {
    const cause = err?.cause?.code || err?.cause?.message || err?.message || 'unreachable';
    throw new RouterUnavailableError(`the music router at ${ROUTER_URL} is not reachable (${cause}) — is the router service running?`);
  }
  if (resp.status === 401) throw new RouterUnavailableError('the music router refused the controller\'s credentials');
  if (!resp.ok) throw new RouterUnavailableError(`the music router answered HTTP ${resp.status}`);
  return resp.json();
}

export async function routerStatus(): Promise<RouterStatus> {
  return routerStatusSchema.parse(await routerFetch('/status'));
}

/** Re-read config.json and rescan plugins now, rather than on the router's next poll. */
export async function routerReload(): Promise<RouterStatus> {
  return routerStatusSchema.parse(await routerFetch('/reload', { method: 'POST' }));
}

export async function routerTest(entry: MusicSourceEntry): Promise<RouterTestResult> {
  return routerTestResultSchema.parse(await routerFetch('/test', { method: 'POST', body: JSON.stringify(entry) }));
}

/** Whether the router answers at all — for the wizard's "can I offer other sources?" */
export async function routerReachable(): Promise<boolean> {
  try {
    await routerStatus();
    return true;
  } catch {
    return false;
  }
}

/** True when the config the router serves is the one on disk (it polls, so it may lag a moment). */
export function routerConfigExists(): boolean {
  return existsSync(ROUTER_CONFIG_PATH);
}
