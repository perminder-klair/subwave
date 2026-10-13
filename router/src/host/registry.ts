// The active source and the plugins it can be built from.
//
// apply() constructs EVERY source in the new selection before swapping, so a
// selection containing a misconfigured or unreachable-at-construction source
// is rejected whole and the running one keeps serving — a typo in the admin
// form must not take the station's library away. The rejection is kept as
// `configError` for the admin UI.
//
// Callers resolve getSource() once per request and reuse it, so a swap in the
// middle of a response cannot split one payload across two backends.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SourceContext, SourceLogger, SourcePlugin } from '../sdk/types.js';
import {
  BUILTIN_DIR,
  DATA_DIR,
  PLUGINS_DIR,
  configStamp,
  envAuth,
  envSources,
  readConfig,
  type RouterConfig,
  type SourceEntry,
} from '../config.js';
import { createComposite } from './composite.js';
import { prefixedCodec, rawCodec } from './ids.js';
import { scanPlugins, type LoadedPlugin } from './loader.js';
import { resolveConfig, type ResolvedConfig } from './manifest.js';
import type { HostSource } from './types.js';
import { wrapPlugin } from './wrap.js';

const CONSTRUCT_TIMEOUT_MS = 15_000;
const PLUGIN_FETCH_TIMEOUT_MS = Number(process.env.ROUTER_PLUGIN_FETCH_TIMEOUT_MS || 20_000);

export interface ActiveEntry {
  plugin: string;
  label: string;
  idPrefix: string;
  rawIds: boolean;
  envLocked: string[];
  source: HostSource;
}

interface State {
  plugins: LoadedPlugin[];
  config: RouterConfig;
  configStamp: string;
  /** JSON of the selection the active source was built from. */
  appliedSpec: string;
  active: HostSource | null;
  entries: ActiveEntry[];
  configError?: string;
}

const state: State = {
  plugins: [],
  config: { version: 1, merge: false, sources: [] },
  configStamp: '',
  appliedSpec: '',
  active: null,
  entries: [],
};

export function logger(scope: string): SourceLogger {
  const tag = `[${scope}]`;
  return {
    info: (...a) => console.log(tag, ...a),
    warn: (...a) => console.warn(tag, ...a),
    error: (...a) => console.error(tag, ...a),
  };
}

// fetch with a default timeout for plugin API calls. A caller-supplied signal
// wins. The timeout covers reaching the server and receiving its headers, not
// the body: stream() may hand back the Response itself ({ response }), and a
// track can take longer than the timeout to arrive over a slow link. An API
// call's body read is still bounded by the op timeout (wrap.ts).
export function pluginFetch(timeoutMs = PLUGIN_FETCH_TIMEOUT_MS): typeof fetch {
  return async (input, init = {}) => {
    if (init.signal) return fetch(input, init);
    const ctrl = new AbortController();
    const timer = setTimeout(
      () => ctrl.abort(new DOMException(`no response within ${timeoutMs}ms`, 'TimeoutError')),
      timeoutMs,
    );
    try {
      return await fetch(input, { ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => timer && clearTimeout(timer));
}

export function findPlugin(name: string): LoadedPlugin | undefined {
  return state.plugins.find((p) => p.manifest?.name === name || (!p.manifest && p.name === name));
}

export class NotConfiguredError extends Error {
  constructor(
    readonly plugin: string,
    readonly missing: string[],
  ) {
    super(`${plugin} is missing required settings: ${missing.join(', ')}`);
    this.name = 'NotConfiguredError';
  }
}

/** Build one wrapped source from a selection entry. Throws with an operator-readable reason. */
export async function buildSource(entry: SourceEntry): Promise<{ source: HostSource; resolved: ResolvedConfig; plugin: LoadedPlugin }> {
  const plugin = findPlugin(entry.plugin);
  if (!plugin) throw new Error(`no music-source plugin named '${entry.plugin}' is installed`);
  if (plugin.error || !plugin.factory || !plugin.manifest) {
    throw new Error(`plugin '${entry.plugin}' cannot load: ${plugin.error ?? 'no entry'}`);
  }
  const manifest = plugin.manifest;
  const resolved = resolveConfig(manifest, entry.config ?? {});
  if (resolved.missing.length) throw new NotConfiguredError(manifest.name, resolved.missing);
  const dataDir = join(DATA_DIR, manifest.name);
  try {
    mkdirSync(dataDir, { recursive: true });
  } catch {
    /* a read-only mount still lets the plugin run; it just has nowhere to write */
  }
  const log = logger(manifest.name);
  const ctx: SourceContext = { config: Object.freeze({ ...resolved.values }), fetch: pluginFetch(), log, dataDir };
  const instance: SourcePlugin = await withTimeout(
    Promise.resolve(plugin.factory(ctx)),
    CONSTRUCT_TIMEOUT_MS,
    `starting ${manifest.name}`,
  );
  if (!instance || typeof instance.song !== 'function') {
    throw new Error(`plugin '${manifest.name}' did not return a source object`);
  }
  const rawIds = entry.rawIds === true;
  const source = wrapPlugin(instance, {
    name: manifest.name,
    label: manifest.label,
    codec: rawIds ? rawCodec() : prefixedCodec(manifest.idPrefix),
    rawIds,
    log,
  });
  return { source, resolved, plugin };
}

function effectiveSources(config: RouterConfig): SourceEntry[] {
  return config.sources.length ? config.sources : envSources();
}

async function apply(config: RouterConfig, force = false): Promise<void> {
  const selection = effectiveSources(config);
  const spec = JSON.stringify({ merge: config.merge, selection });
  if (!force && spec === state.appliedSpec) return;

  if (selection.length > 1 && !config.merge) {
    state.configError = 'several sources are selected but merging is off';
    return;
  }
  if (selection.filter((s) => s.rawIds).length > 1) {
    state.configError = 'only one source can keep raw ids';
    return;
  }

  const built: ActiveEntry[] = [];
  try {
    for (const entry of selection) {
      const { source, resolved, plugin } = await buildSource(entry);
      built.push({
        plugin: plugin.manifest!.name,
        label: plugin.manifest!.label,
        idPrefix: plugin.manifest!.idPrefix,
        rawIds: entry.rawIds === true,
        envLocked: resolved.envLocked,
        source,
      });
    }
  } catch (err) {
    await Promise.all(built.map((b) => b.source.close()));
    state.configError = (err as Error).message;
    console.warn(`[router] kept the running source — ${state.configError}`);
    return;
  }

  const next = built.length === 0 ? null : built.length === 1 ? built[0]!.source : createComposite(built.map((b) => b.source));
  const previous = state.active;
  state.active = next;
  state.entries = built;
  state.appliedSpec = spec;
  state.configError = undefined;
  console.log(`[router] serving ${next ? `${next.label} (${next.name})` : 'nothing — no source selected'}`);
  if (previous && previous !== next) void previous.close();
}

// Reloads run one at a time. The poll, POST /internal/reload and a failed
// login's refresh can all ask at once, and run concurrently an older build
// that finished last (an async factory can take seconds) swapped in a
// selection config.json no longer named — with the stamp already read, so
// nothing re-read it. A queued reload reads the file when its turn comes, so
// the last one always applies what the file says now.
let reloads: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(job: () => Promise<T>): Promise<T> {
  const run = reloads.then(job, job);
  reloads = run.catch(() => {});
  return run;
}

/** Re-read config.json; rebuild the active source when the selection changed. */
export function reloadConfig(force = false): Promise<void> {
  return oneAtATime(() => reloadNow(force));
}

async function reloadNow(force: boolean): Promise<void> {
  const read = readConfig();
  state.configStamp = read.stamp;
  if (read.error) {
    state.configError = read.error;
    console.warn(`[router] ${read.error} — keeping the running source`);
    return;
  }
  state.config = read.config;
  await apply(read.config, force);
}

/** Rescan plugin folders, then rebuild from the current config. */
export function rescan(): Promise<void> {
  return oneAtATime(async () => {
    state.plugins = await scanPlugins(BUILTIN_DIR, PLUGINS_DIR);
    for (const p of state.plugins) {
      if (p.error) console.warn(`[router] plugin ${p.name} (${p.builtin ? 'built-in' : p.dir}): ${p.error}`);
    }
    await reloadNow(true);
  });
}

export function getSource(): HostSource | null {
  return state.active;
}

export function activeEntries(): ActiveEntry[] {
  return state.entries;
}

export function plugins(): LoadedPlugin[] {
  return state.plugins;
}

export function configError(): string | undefined {
  return state.configError;
}

export function currentConfig(): RouterConfig {
  return state.config;
}

export function configStampSeen(): string {
  return state.configStamp;
}

/**
 * Re-read config.json now if it changed since the last read. Called when a
 * login fails: the controller writes new credentials and immediately uses
 * them, which must not wait for the next poll.
 */
export async function refreshIfChanged(): Promise<boolean> {
  if (configStamp() === state.configStamp) return false;
  await reloadConfig();
  return true;
}

/** The credentials /rest and /internal accept: config.json first, env as the dev fallback. */
export function credentials(): { user: string; pass: string } | undefined {
  return state.config.auth ?? envAuth();
}
