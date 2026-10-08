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
import { chmod, lchown, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { STATE_DIR, STATE_ROOT } from '../config.js';
import { envInt, envUrl } from '../util/env.js';
import { writeFileAtomic } from '../util/atomic-file.js';
import {
  DEFAULT_MUSIC_SELECTION,
  musicSecretKeys,
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

// The router runs as an unprivileged user, since plugins are third-party code
// (#1827 review). Compose (`user:`) and the AIO supervisor (setpriv) run it as
// ROUTER_UID:ROUTER_GID — 1000 by default, the router image's `node` — and the
// controller hands it the files it needs. Keep all three in step.
export const ROUTER_UID = envInt('ROUTER_UID', 1000, { min: 1 });
export const ROUTER_GID = envInt('ROUTER_GID', 1000, { min: 1 });
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
// When this process last resolved its selection (and with it the live
// connection). A maintenance child's walk reads the library it loaded at this
// moment, which is how adoption tells a walk of the old library from a walk of
// the new one (music/source-switch.ts switchedAfter). null until loaded.
let currentSince: number | null = null;

export function currentSelection(): MusicSelection {
  return current;
}

export function currentSelectionSince(): number | null {
  return currentSince;
}

export function setCurrentSelection(sel: MusicSelection): void {
  current = sel;
  currentSince = Date.now();
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
  await handRouterState();
  return auth;
}

let handOverWarned = false;

/**
 * Give the router's user what it reads and writes: config.json (0600, written
 * by root here) and the data folder its plugins keep state in. state/router
 * itself and the plugins folder stay root's, so plugin code cannot swap
 * config.json, the data folder or a plugin for something else. Nothing INSIDE
 * data/ is touched: the router creates it as its own user, and plugin code
 * controls it, so a root walk there could be steered (a directory swapped for
 * a link mid-walk) into handing over anything. Only root can hand files over,
 * and only root needs to — a controller running as an ordinary user (local
 * dev) shares its uid with the router it started.
 *
 * Never fatal: a filesystem that refuses chown is a degraded mount, not a
 * reason to stop, so config.json falls back to 0644 (the router can still read
 * its credentials) and the refusal is logged once.
 */
export async function handRouterState(): Promise<void> {
  if (process.getuid?.() !== 0) return;
  try {
    const data = path.join(ROUTER_DIR, 'data');
    await mkdir(data, { recursive: true });
    if (existsSync(ROUTER_CONFIG_PATH)) await lchown(ROUTER_CONFIG_PATH, ROUTER_UID, ROUTER_GID);
    await lchown(data, ROUTER_UID, ROUTER_GID);
  } catch (err: any) {
    await chmod(ROUTER_CONFIG_PATH, 0o644).catch(() => {});
    if (!handOverWarned) {
      handOverWarned = true;
      console.warn(`[music-source] could not hand state/router to uid ${ROUTER_UID} (${err?.code || err?.message}); config.json is world-readable instead`);
    }
  }
}

/** The connection music/subsonic.ts uses in router mode. */
export function routerConnection(auth: RouterAuth | null): { url: string; user: string; password: string } {
  return { url: ROUTER_URL, user: auth?.user ?? '', password: auth?.pass ?? '' };
}

// --- secrets in the browser ---------------------------------------------------

const secretKeys = musicSecretKeys;

export interface MaskedSourceEntry extends MusicSourceEntry {
  /** Secret keys that have a stored value; the values themselves never leave the process. */
  secretsSet: string[];
}

export function maskSelection(sel: MusicSelection, plugins: readonly MusicPluginInfo[]): { mode: MusicSelection['mode']; merge: boolean; sources: MaskedSourceEntry[] } {
  return {
    mode: sel.mode,
    merge: sel.merge,
    sources: sel.sources.map((entry) => {
      // Without the manifest we cannot tell a secret from a URL, so nothing is
      // shown. A plugin whose manifest failed to load is listed with no config
      // fields, which would otherwise read as "no secrets" and show them all.
      const listed = plugins.find((p) => p.name === entry.plugin);
      const plugin = listed && !(listed.error && listed.config.length === 0) ? listed : undefined;
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

// A stored secret is only safe to reuse where it was meant to go. A blank
// secret in a draft falls back to the stored one only while every `url` field
// still says what was stored — otherwise Test (or Save) would send the stored
// API key, token or password-derived token to whatever host the draft names.
// Changing the server means typing its secret again.
function storedSecretsFor(entry: MusicSourceEntry, prev: MusicSourceEntry[], plugin: MusicPluginInfo | undefined): MusicSourceEntry | undefined {
  const old = prev.find((p) => p.plugin === entry.plugin);
  if (!old) return undefined;
  const same = (a: unknown, b: unknown) => String(a ?? '').trim() === String(b ?? '').trim();
  const urls = (plugin?.config ?? []).filter((f) => f.type === 'url');
  return urls.every((f) => same(entry.config[f.key], old.config[f.key])) ? old : undefined;
}

const blank = (v: unknown) => v === undefined || v === null || v === '';

/** A blank secret in a draft keeps the stored one for the same plugin and server. */
export function keepStoredSecrets(
  next: MusicSourceEntry[],
  prev: MusicSourceEntry[],
  plugins: readonly MusicPluginInfo[],
): MusicSourceEntry[] {
  return next.map((entry) => {
    const plugin = plugins.find((p) => p.name === entry.plugin);
    const old = storedSecretsFor(entry, prev, plugin);
    if (!old) return entry;
    const config = { ...entry.config };
    for (const key of secretKeys(plugin)) {
      if (blank(config[key]) && old.config[key] !== undefined) config[key] = old.config[key];
    }
    return { ...entry, config };
  });
}

/** Secret keys a draft left blank that will fall back to a stored value. */
export function keptSecretKeys(entry: MusicSourceEntry, prev: MusicSourceEntry[], plugin: MusicPluginInfo | undefined): string[] {
  const old = storedSecretsFor(entry, prev, plugin);
  if (!old) return [];
  return secretKeys(plugin).filter((k) => blank(entry.config[k]) && !blank(old.config[k]));
}

// --- source switches ------------------------------------------------------------

/** Shared with the admin form's id-change warning (schemas/music-source.ts). */
export { musicSelectionIdentity as selectionIdentity } from '../schemas/music-source.js';

/**
 * Record that track ids are about to change. The next complete library walk
 * reads this and carries tags, analysis, likes and the blocklist across by
 * matching tracks on their metadata (music/source-switch.ts).
 */
export async function markSourceSwitch(from: string, to: string): Promise<void> {
  await mkdir(path.dirname(SOURCE_SWITCH_PATH), { recursive: true });
  // Atomic: the reader treats an unparsable marker as no switch at all.
  await writeFileAtomic(SOURCE_SWITCH_PATH, JSON.stringify({ version: 1, at: new Date().toISOString(), from, to }, null, 2));
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
