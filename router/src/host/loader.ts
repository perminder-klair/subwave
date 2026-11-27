// Discovers music-source plugins: built-ins under src/sources/<name>/ and
// operator-installed ones under state/router/plugins/<name>/. Both have the
// same shape — a subwave-source.json manifest beside an entry module — and go
// through the same validation, so a built-in is just a pre-installed plugin.
//
// Loading never throws. A plugin with a bad manifest, an incompatible API
// version, a clashing name or prefix, or an entry that fails to import is
// recorded with its error and shown in the admin UI; every other plugin still
// loads. Built-ins are scanned first and win every clash, so an installed
// plugin can never shadow one.
//
// Third-party entries are imported with a cache-busting query keyed on the
// file's mtime (the technique controller/src/skills/loader.ts uses), so a
// Rescan picks up an edited plugin without restarting the router, while an
// unchanged one is not re-imported.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SOURCE_API_VERSION, type SourceFactory, type SourceManifest, type SourcePlugin } from '../sdk/types.js';
import { parseManifest } from './manifest.js';

export const MANIFEST = 'subwave-source.json';

export interface LoadedPlugin {
  /** Directory name until the manifest is read; the manifest's name afterwards. */
  name: string;
  dir: string;
  builtin: boolean;
  manifest?: SourceManifest;
  factory?: SourceFactory;
  error?: string;
}

const moduleCache = new Map<string, { stamp: string; factory: SourceFactory }>();

function subdirs(root: string): string[] {
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_'))
      .map((d) => join(root, d.name))
      .sort();
  } catch {
    return [];
  }
}

function toFactory(mod: Record<string, unknown>): SourceFactory {
  const exported = mod.default ?? mod.source ?? mod.createSource;
  if (typeof exported === 'function') return exported as SourceFactory;
  if (exported && typeof exported === 'object' && typeof (exported as SourcePlugin).song === 'function') {
    return () => exported as SourcePlugin;
  }
  throw new Error('entry must default-export defineSource((ctx) => ({ … }))');
}

async function importEntry(file: string, builtin: boolean): Promise<SourceFactory> {
  const st = statSync(file);
  const stamp = `${st.mtimeMs}:${st.size}`;
  const cached = moduleCache.get(file);
  if (cached && (builtin || cached.stamp === stamp)) return cached.factory;
  const url = pathToFileURL(file).href + (builtin ? '' : `?v=${encodeURIComponent(stamp)}`);
  const factory = toFactory((await import(url)) as Record<string, unknown>);
  moduleCache.set(file, { stamp, factory });
  return factory;
}

/** Load one plugin folder. Never throws; a failure is recorded on the result. */
export async function loadPlugin(dir: string, builtin: boolean): Promise<LoadedPlugin> {
  const plugin: LoadedPlugin = { name: dir.split(sep).pop() ?? dir, dir, builtin };
  const manifestPath = join(dir, MANIFEST);
  if (!existsSync(manifestPath)) {
    plugin.error = `no ${MANIFEST} in this folder`;
    return plugin;
  }
  try {
    plugin.manifest = parseManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
    plugin.name = plugin.manifest.name;
  } catch (err) {
    plugin.error = (err as Error).message;
    return plugin;
  }
  if (plugin.manifest.apiVersion !== SOURCE_API_VERSION) {
    plugin.error = `written for plugin API v${plugin.manifest.apiVersion}; this router implements v${SOURCE_API_VERSION}`;
    return plugin;
  }
  const entry = resolve(dir, plugin.manifest.entry ?? (builtin ? 'index.ts' : 'index.mjs'));
  const rel = relative(dir, entry);
  if (rel.startsWith('..') || rel.includes(`..${sep}`) || resolve(dir, rel) !== entry) {
    plugin.error = 'entry must stay inside the plugin folder';
    return plugin;
  }
  if (!existsSync(entry)) {
    plugin.error = `entry ${rel} not found`;
    return plugin;
  }
  try {
    plugin.factory = await importEntry(entry, builtin);
  } catch (err) {
    plugin.error = `failed to load ${rel}: ${(err as Error).message}`;
  }
  return plugin;
}

export async function scanPlugins(builtinDir: string, pluginsDir: string): Promise<LoadedPlugin[]> {
  const out: LoadedPlugin[] = [];
  const names = new Map<string, LoadedPlugin>();
  const prefixes = new Map<string, LoadedPlugin>();
  const candidates = [
    ...subdirs(builtinDir).map((d) => ({ dir: d, builtin: true })),
    ...subdirs(pluginsDir).map((d) => ({ dir: d, builtin: false })),
  ];
  for (const { dir, builtin } of candidates) {
    const plugin = await loadPlugin(dir, builtin);
    const m = plugin.manifest;
    if (m && !plugin.error) {
      const nameClash = names.get(m.name);
      const prefixClash = prefixes.get(m.idPrefix);
      if (nameClash) {
        plugin.error = `name '${m.name}' is already taken by ${nameClash.builtin ? 'a built-in source' : nameClash.dir}`;
        plugin.factory = undefined;
      } else if (prefixClash) {
        plugin.error = `idPrefix '${m.idPrefix}' is already used by '${prefixClash.name}'`;
        plugin.factory = undefined;
      } else {
        names.set(m.name, plugin);
        prefixes.set(m.idPrefix, plugin);
      }
    }
    out.push(plugin);
  }
  return out;
}
