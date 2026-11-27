// `subwave source list | add | remove` — music-source plugins without a shell,
// sudo or knowing where the state folder is (#2414). The heavy lifting and the
// reasoning are in ../sources.ts; this file is the conversation.
//
// The router stays the only judge of a plugin: `add` copies it in, asks for a
// rescan (POST /settings/music-source/rescan, the admin's own button) and
// reports what the router said, undoing the copy if the router refused it.
// Nothing restarts. Mounting a folder the plugin reads stays a compose edit the
// operator makes; `add` prints it rather than making it.

import { rmSync } from 'node:fs';
import { makeClient } from '../api.ts';
import { detectCompose, type ComposeEnv } from '../compose.ts';
import {
  fetchPlugin,
  formatBytes,
  hostPluginsDir,
  inspectPlugin,
  installedFolders,
  installedManifest,
  parsePluginSource,
  rootOp,
  type Inspected,
} from '../sources.ts';
import { MENU_BACK, err, exitIfCancelled, header, info, muted, ok, p, pauseForEnter, pc, warn } from '../ui.ts';

// Keep in step with controller/src/schemas/music-source.ts (musicPluginInfoSchema,
// routerStatusSchema) and GET /settings/music-source; only what is shown here.
interface PluginInfo {
  name: string;
  label?: string;
  version?: string;
  apiVersion?: number;
  builtin?: boolean;
  error?: string | null;
}
interface MusicSourceState {
  mode?: 'navidrome' | 'router';
  sources?: Array<{ plugin: string }>;
  router?: { router?: { apiVersion?: number }; plugins?: PluginInfo[] } | null;
  routerError?: string | null;
}

interface Station {
  env: ComposeEnv;
  state: MusicSourceState | null;
  /** Why `state` is null, for the operator. */
  why?: string;
}

async function readStation(): Promise<Station> {
  const env = detectCompose().env;
  if (env === 'down') return { env, state: null, why: 'the stack is down' };
  const r = await makeClient(env).get<MusicSourceState>('/settings/music-source', { admin: true, timeoutMs: 8000 });
  if (r.status === 401) return { env, state: null, why: 'the controller refused the admin login in .env' };
  if (!r.ok || !r.body) return { env, state: null, why: `the controller did not answer (${r.error ?? 'no body'})` };
  return { env, state: r.body };
}

async function rescan(env: ComposeEnv): Promise<{ plugins: PluginInfo[] } | { error: string }> {
  if (env === 'down') return { error: 'the stack is down' };
  const r = await makeClient(env).post<{ ok?: boolean; router?: { plugins?: PluginInfo[] }; error?: string }>(
    '/settings/music-source/rescan', {}, { admin: true, timeoutMs: 30_000 },
  );
  if (!r.ok || !r.body?.ok) return { error: r.body?.error ?? r.error ?? 'rescan failed' };
  return { plugins: r.body.router?.plugins ?? [] };
}

function selectedPlugins(state: MusicSourceState | null): string[] {
  if (!state || state.mode !== 'router') return [];
  return (state.sources ?? []).map((s) => s.plugin);
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

// ---- list -----------------------------------------------------------------------

export async function runSourceList(): Promise<void> {
  header('Music-source plugins');
  const station = await readStation();
  const plugins = station.state?.router?.plugins;
  const selected = selectedPlugins(station.state);

  if (plugins) {
    for (const pl of plugins) {
      const tag = pl.builtin ? pc.dim('built-in') : pc.cyan('installed');
      const on = selected.includes(pl.name) ? pc.green(' ● on air') : '';
      const version = pl.version ? pc.dim(` v${pl.version}`) : '';
      const line = `${pc.bold(pl.name)}  ${pl.label ?? ''}${version}  ${tag}${on}`;
      if (pl.error) {
        err(line);
        muted(`    ${pl.error}`);
      } else ok(line);
    }
    // A folder the router didn't report would be one it couldn't read at all.
    const reported = new Set(plugins.map((pl) => pl.name));
    for (const f of installedFolders()) {
      if (!reported.has(f) && !reported.has(str(installedManifest(f)?.name))) {
        warn(`${pc.bold(f)}  in the plugins folder, but the router didn't list it`);
      }
    }
  } else {
    warn(`Can't ask the router: ${station.why ?? station.state?.routerError ?? 'the music router is not reachable'}.`);
    const folders = installedFolders();
    if (folders.length === 0) info('No plugins installed.');
    for (const f of folders) {
      const m = installedManifest(f);
      info(`${pc.bold(f)}  ${str(m?.label)}${m?.version ? pc.dim(` v${str(m.version)}`) : ''}  ${pc.dim('(not checked)')}`);
    }
  }
  console.log();
  muted(`Plugins folder: ${hostPluginsDir()}`);
}

// ---- add --------------------------------------------------------------------------

export interface SourceAddOpts {
  source: string;
  ref?: string;
  path?: string;
  yes?: boolean;
}

function showPlugin(found: Inspected, from: string): void {
  const m = found.manifest;
  header(`${str(m.label) || found.name} ${pc.dim(`(${found.name})`)}`);
  info(`version ${str(m.version) || '?'} · plugin API v${str(m.apiVersion) || '?'}${m.homepage ? ` · ${str(m.homepage)}` : ''}`);
  if (m.description) muted(str(m.description));
  console.log();
  const total = found.files.reduce((n, f) => n + f.size, 0);
  info(`${found.files.length} file(s), ${formatBytes(total)}, from ${from}:`);
  const shown = found.files.slice(0, 40);
  for (const f of shown) muted(`    ${f.rel}  ${pc.dim(formatBytes(f.size))}`);
  if (found.files.length > shown.length) muted(`    … and ${found.files.length - shown.length} more`);
}

export async function runSourceAdd(opts: SourceAddOpts): Promise<void> {
  let fetched: Awaited<ReturnType<typeof fetchPlugin>> | undefined;
  try {
    const src = parsePluginSource(opts.source, { ref: opts.ref, path: opts.path });
    if (src.kind !== 'dir') info(`Fetching ${src.url}${src.kind === 'git' && src.ref ? ` at ${src.ref}` : ''}…`);
    fetched = await fetchPlugin(src);
    const found = inspectPlugin(fetched.dir);
    showPlugin(found, fetched.dir);

    const station = await readStation();
    const known = station.state?.router?.plugins?.find((pl) => pl.name === found.name);
    if (known?.builtin) {
      err(`"${found.name}" is a built-in source; the router won't let a plugin replace it. Rename the plugin.`);
      process.exitCode = 1;
      return;
    }
    const routerApi = station.state?.router?.router?.apiVersion;
    // The router's own answer, so this is its rule applied early, not a copy:
    // it would refuse the plugin on the rescan anyway.
    if (routerApi !== undefined && found.manifest.apiVersion !== routerApi) {
      err(`It targets plugin API v${str(found.manifest.apiVersion)}, and this station's router implements v${routerApi}, so it can't load.`);
      muted('Look for a version of the plugin built for this API, or update SUB/WAVE.');
      process.exitCode = 1;
      return;
    }
    const existing = installedManifest(found.name);

    console.log();
    warn('A plugin is code that runs inside your music router, with network access.');
    muted(`Read it before you install it: ${fetched.dir}`);
    if (existing) muted(`This replaces the installed ${found.name} v${str(existing.version) || '?'}. Its data folder is kept.`);
    if (!opts.yes) {
      const go = exitIfCancelled(await p.confirm({
        message: existing ? `Replace ${found.name} with this version?` : `Install ${found.name}?`,
        initialValue: false,
      }));
      if (!go) {
        info('Nothing installed.');
        return;
      }
    }

    await rootOp(found.name, 'install', fetched.dir);
    ok(`Copied to ${hostPluginsDir()}/${found.name}/`);

    const scan = await rescan(station.env);
    if ('error' in scan) {
      await rootOp(found.name, 'commit');
      warn(`Couldn't rescan: ${scan.error}. The router checks it when the stack next starts.`);
      muted('`subwave source list` shows whether it loaded.');
    } else {
      const loaded = scan.plugins.find((pl) => pl.name === found.name && !pl.builtin);
      if (!loaded || loaded.error) {
        await rootOp(found.name, 'restore');
        err(`The router refused it: ${loaded?.error ?? 'it did not appear after the rescan'}.`);
        muted(existing ? 'The previous version is back in place.' : 'Removed it again.');
        process.exitCode = 1;
        return;
      }
      await rootOp(found.name, 'commit');
      ok(`The router loaded ${loaded.label ?? found.name}${loaded.version ? ` v${loaded.version}` : ''}.`);
      info('Choose it in Admin → Music source.');
    }

    console.log();
    muted('If it reads music from this machine, mount that folder into the router, read-only,');
    muted('under the router service in your compose file, then `docker compose up -d router`:');
    muted('    volumes:');
    muted('      - /path/to/your/music:/music:ro');
    muted("The plugin's README says what it needs.");
  } catch (e) {
    // Esc at a prompt inside the menu means "go back", not a failure.
    if (e === MENU_BACK) throw e;
    err((e as Error).message);
    process.exitCode = 1;
  } finally {
    if (fetched?.temp) rmSync(fetched.temp, { recursive: true, force: true });
  }
}

// ---- remove -------------------------------------------------------------------------

export interface SourceRemoveOpts {
  name: string;
  yes?: boolean;
  force?: boolean;
  purgeData?: boolean;
}

export async function runSourceRemove(opts: SourceRemoveOpts): Promise<void> {
  try {
    const { name } = opts;
    const station = await readStation();
    const known = station.state?.router?.plugins?.find((pl) => pl.name === name);
    if (known?.builtin) {
      err(`"${name}" is a built-in source; it can't be removed.`);
      process.exitCode = 1;
      return;
    }
    if (!installedFolders().includes(name)) {
      err(`No plugin folder named "${name}" in ${hostPluginsDir()}.`);
      process.exitCode = 1;
      return;
    }
    // Removing the plugin the station is playing from would leave it with no
    // music. Without an answer from the controller that can't be ruled out.
    if (selectedPlugins(station.state).includes(name)) {
      err(`${name} is a selected music source. Switch to another in Admin → Music source first.`);
      process.exitCode = 1;
      return;
    }
    if (!station.state && !opts.force) {
      err(`Can't check that ${name} isn't the station's music source: ${station.why}.`);
      muted('Start the stack, or pass --force if you know it isn\'t.');
      process.exitCode = 1;
      return;
    }

    if (!opts.yes) {
      const go = exitIfCancelled(await p.confirm({
        message: `Remove ${name}${opts.purgeData ? ' and its data folder' : ''}?`,
        initialValue: false,
      }));
      if (!go) {
        info('Nothing removed.');
        return;
      }
    }
    await rootOp(name, 'remove');
    if (opts.purgeData) await rootOp(name, 'purge-data');
    ok(`Removed ${name}${opts.purgeData ? ' and its data' : ''}.`);
    if (!opts.purgeData) muted(`Its data folder is kept (state/router/data/${name}); --purge-data removes it.`);
    const scan = await rescan(station.env);
    if ('error' in scan) muted(`The router drops it on its next scan (${scan.error}).`);
  } catch (e) {
    // Esc at a prompt inside the menu means "go back", not a failure.
    if (e === MENU_BACK) throw e;
    err((e as Error).message);
    process.exitCode = 1;
  }
}

// ---- the interactive menu's entry -------------------------------------------------

export async function runSourceMenu(): Promise<void> {
  const installed = installedFolders();
  const choice = exitIfCancelled(await p.select({
    message: 'Music-source plugins',
    options: [
      { value: 'list', label: 'list', hint: 'installed and built-in plugins, with any load errors' },
      { value: 'add', label: 'add', hint: 'install one from a folder, git URL, GitHub link or archive URL' },
      ...(installed.length ? [{ value: 'remove', label: 'remove', hint: 'remove an installed plugin' }] : []),
    ],
  }));

  if (choice === 'list') {
    await runSourceList();
  } else if (choice === 'add') {
    const source = exitIfCancelled(await p.text({
      message: 'Plugin folder or link',
      placeholder: 'https://github.com/someone/subwave-emby  or  ./my-plugin',
      validate: (v) => (v && v.trim() ? undefined : 'Enter a folder or a link'),
    }));
    await runSourceAdd({ source: source.trim() });
  } else if (choice === 'remove') {
    const name = exitIfCancelled(await p.select({
      message: 'Remove which plugin?',
      options: installed.map((n) => ({ value: n, label: n, hint: str(installedManifest(n)?.label) })),
    }));
    await runSourceRemove({ name });
  }
  await pauseForEnter();
}
