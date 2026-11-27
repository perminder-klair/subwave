// Music-source plugin installs for `subwave source …` (#2414). The router is the
// one judge of a plugin: this module fetches a plugin, shows it, copies it into
// state/router/plugins/<name>/ and asks the router to rescan, then reports the
// router's own verdict. It checks only what it must to act safely — a folder
// name it can create, no links or special files to copy — and never restates
// the loader's manifest rules (router/src/host/loader.ts, manifest.ts).
//
// The plugins folder belongs to root, so plugin code can never rewrite a plugin
// (controller/src/setup/music-source.ts handRouterState). The CLI writes there
// through a one-off controller container, which runs as root and already mounts
// the state folder at /var/sub-wave: the plugin arrives as a tar on stdin, is
// unpacked into a staging folder the router skips (dot-prefixed), handed to
// root and moved into place. No sudo on the host, and the result is owned
// exactly as the router expects.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { detectCompose, getComposeFiles, type ComposeFile } from './compose.ts';
import { composeFileArgs } from './docker.ts';
import { getRootEnv, getSubwaveHome, have, readEnvValue } from './util.ts';

export const MANIFEST = 'subwave-source.json';

/** The folder a plugin installs into is its manifest name. This only decides
 *  whether the CLI can safely create that folder; the router's loader still
 *  judges the manifest (and refuses the same names, MUSIC_PLUGIN_NAME_RE). */
export const PLUGIN_FOLDER_RE = /^[a-z][a-z0-9-]{1,31}$/;

/** Where the state folder is mounted inside the controller container. */
const CONTAINER_STATE = '/var/sub-wave';

// ---- where plugins live ----------------------------------------------------

/** state/router/plugins on the host, following compose's `${STATE_DIR:-./state}`:
 *  a shell export wins over the install's .env, and a relative path is the
 *  install's. */
export function hostPluginsDir(): string {
  const raw = process.env.STATE_DIR?.trim() || readEnvValue(getRootEnv(), 'STATE_DIR') || './state';
  const state = isAbsolute(raw) ? raw : resolve(getSubwaveHome(), raw);
  return join(state, 'router', 'plugins');
}

export function hostDataDir(name: string): string {
  return join(hostPluginsDir(), '..', 'data', name);
}

// ---- what to fetch ----------------------------------------------------------

export type PluginSource =
  | { kind: 'dir'; path: string }
  | { kind: 'git'; url: string; ref?: string; subdir?: string }
  | { kind: 'archive'; url: string; format: 'tgz' | 'zip'; subdir?: string };

/**
 * Reads `add`'s argument. A local folder wins; then a GitHub folder link
 * (`/tree/<ref>/<path>`, what the /plugins directory links), an archive URL,
 * and anything else over http(s) or ending in .git as a git remote. `--ref`
 * and `--path` override what the link says, for a branch name with a slash.
 */
export function parsePluginSource(arg: string, opts: { ref?: string; path?: string } = {}): PluginSource {
  const local = resolve(arg);
  if (existsSync(local) && lstatSync(local).isDirectory()) {
    return { kind: 'dir', path: opts.path ? resolve(local, opts.path) : local };
  }
  // scp-style git remotes (git@host:owner/repo.git) are not URLs.
  if (/^[\w.-]+@[\w.-]+:[^/]/.test(arg)) return { kind: 'git', url: arg, ref: opts.ref, subdir: opts.path };
  let url: URL;
  try {
    url = new URL(arg);
  } catch {
    throw new Error(`${arg} is not a folder here, and not a URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:' && url.protocol !== 'ssh:') {
    throw new Error(`unsupported URL scheme ${url.protocol}`);
  }
  if (url.search || url.hash) throw new Error('a plugin URL carries no query or fragment: use --ref and --path');

  const tree = /^\/([^/]+)\/([^/]+)\/tree\/([^/]+)(?:\/(.+?))?\/?$/.exec(url.pathname);
  if (url.host === 'github.com' && tree) {
    const [, owner, repo, ref, sub] = tree;
    return {
      kind: 'git',
      url: `https://github.com/${owner}/${repo}.git`,
      ref: opts.ref ?? ref,
      subdir: opts.path ?? sub,
    };
  }
  const path = url.pathname.toLowerCase();
  if (path.endsWith('.tar.gz') || path.endsWith('.tgz')) return { kind: 'archive', url: arg, format: 'tgz', subdir: opts.path };
  if (path.endsWith('.zip')) return { kind: 'archive', url: arg, format: 'zip', subdir: opts.path };
  return { kind: 'git', url: arg, ref: opts.ref, subdir: opts.path };
}

/** A subfolder from a link or --path, kept inside what was fetched. */
function within(root: string, sub: string | undefined): string {
  if (!sub) return root;
  const dir = resolve(root, sub);
  const rel = relative(root, dir);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`--path ${sub} leaves the fetched folder`);
  return dir;
}

export interface Fetched {
  /** The plugin folder, holding its manifest. */
  dir: string;
  /** A temporary folder to delete afterwards; undefined for a local folder. */
  temp?: string;
}

function runQuiet(cmd: string, args: string[], cwd?: string): void {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    const why = (r.stderr || r.stdout || r.error?.message || '').trim().split('\n').slice(-3).join(' ');
    throw new Error(`${cmd} ${args[0]} failed${why ? `: ${why}` : ''}`);
  }
}

/** Fetches a plugin to a local folder. Nothing fetched is run. */
export async function fetchPlugin(src: PluginSource): Promise<Fetched> {
  if (src.kind === 'dir') return { dir: src.path };
  const temp = mkdtempSync(join(tmpdir(), 'subwave-plugin-'));
  try {
    if (src.kind === 'git') {
      if (!have('git')) throw new Error('git is not installed; clone the plugin yourself and pass its folder');
      const args = ['clone', '--quiet', '--depth', '1', ...(src.ref ? ['--branch', src.ref] : []), '--', src.url, 'src'];
      runQuiet('git', args, temp);
      return { dir: within(join(temp, 'src'), src.subdir), temp };
    }
    const res = await fetch(src.url, { redirect: 'follow', signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const file = join(temp, src.format === 'zip' ? 'plugin.zip' : 'plugin.tgz');
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    const out = join(temp, 'src');
    runQuiet('mkdir', ['-p', out]);
    if (src.format === 'zip') {
      if (!have('unzip')) throw new Error('unzip is not installed; unpack the archive yourself and pass its folder');
      runQuiet('unzip', ['-q', file, '-d', out]);
    } else {
      runQuiet('tar', ['-xzf', file, '-C', out]);
    }
    // A release archive usually wraps everything in one top-level folder.
    let root = out;
    const top = readdirSync(out, { withFileTypes: true });
    if (top.length === 1 && top[0]!.isDirectory() && !existsSync(join(out, MANIFEST))) root = join(out, top[0]!.name);
    return { dir: within(root, src.subdir), temp };
  } catch (e) {
    rmSync(temp, { recursive: true, force: true });
    throw e;
  }
}

// ---- what is in it ----------------------------------------------------------

export interface PluginFile {
  rel: string;
  size: number;
}

export interface Inspected {
  manifest: Record<string, unknown>;
  name: string;
  files: PluginFile[];
}

/**
 * Lists what would be copied and refuses what the copy can't carry safely: a
 * symbolic link, hard link or special file could point the root-run unpack, or
 * the router, at something outside the plugin. `.git` is left behind.
 */
export function inspectPlugin(dir: string): Inspected {
  const manifestPath = join(dir, MANIFEST);
  if (!existsSync(manifestPath)) throw new Error(`no ${MANIFEST} in ${dir}`);
  let manifest: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    manifest = parsed as Record<string, unknown>;
  } catch (e) {
    throw new Error(`${MANIFEST} is not valid JSON (${(e as Error).message})`);
  }
  const name = typeof manifest.name === 'string' ? manifest.name : '';
  if (!PLUGIN_FOLDER_RE.test(name)) {
    throw new Error(`the manifest name "${name}" can't be a plugin folder (lowercase letters, digits and dashes, 2–32 long)`);
  }

  const files: PluginFile[] = [];
  const walk = (abs: string): void => {
    for (const ent of readdirSync(abs, { withFileTypes: true })) {
      if (ent.name === '.git') continue;
      const path = join(abs, ent.name);
      const rel = relative(dir, path);
      const st = lstatSync(path);
      if (st.isSymbolicLink()) throw new Error(`${rel} is a symbolic link; a plugin is copied as plain files`);
      if (st.isDirectory()) walk(path);
      else if (st.isFile()) {
        if (st.nlink > 1) throw new Error(`${rel} is a hard link; a plugin is copied as plain files`);
        files.push({ rel, size: st.size });
      } else throw new Error(`${rel} is not a regular file`);
    }
  };
  walk(dir);
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return { manifest, name, files };
}

/** The installed copy's manifest, read from the host (the folder is world-readable). */
export function installedManifest(name: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(hostPluginsDir(), name, MANIFEST), 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Folders in the plugins dir the router would scan (it skips . and _). */
export function installedFolders(): string[] {
  try {
    return readdirSync(hostPluginsDir(), { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_'))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

// ---- writing as root, through the controller image ----------------------------

/** The compose file to run the one-off container from: the live one, else the
 *  first the install has. */
function composeFileForRun(): ComposeFile {
  const live = detectCompose().file;
  if (live) return live;
  const first = getComposeFiles().find((f) => existsSync(f.abs));
  if (!first) throw new Error('no compose file in this install');
  return first;
}

// Runs as root inside the controller image, with the state folder at
// /var/sub-wave. $1 is the plugin name (already PLUGIN_FOLDER_RE), $2 the verb.
// `install` keeps the replaced copy at router/.plugin-backup/<name> (outside
// the scanned folder) until `commit` drops it or `restore` puts it back.
const ROOT_SCRIPT = `
set -eu
name="$1"; verb="$2"
root="${CONTAINER_STATE}/router"; plugins="$root/plugins"; backup="$root/.plugin-backup"
mkdir -p "$plugins" "$backup"
case "$verb" in
  install)
    stage="$plugins/.incoming-$name"
    rm -rf "$stage" "$backup/$name"
    mkdir "$stage"
    tar -xf - -C "$stage" --no-same-owner --no-same-permissions
    chown -R 0:0 "$stage"
    chmod -R u=rwX,go=rX "$stage"
    if [ -e "$plugins/$name" ]; then mv "$plugins/$name" "$backup/$name"; fi
    mv "$stage" "$plugins/$name"
    ;;
  commit) rm -rf "$backup/$name" ;;
  restore)
    rm -rf "$plugins/$name"
    if [ -e "$backup/$name" ]; then mv "$backup/$name" "$plugins/$name"; fi
    ;;
  remove) rm -rf "$plugins/$name" "$backup/$name" ;;
  purge-data) rm -rf "$root/data/$name" ;;
  *) echo "unknown verb $verb" >&2; exit 2 ;;
esac
`;

function rootRunArgs(name: string, verb: string): string[] {
  const file = composeFileForRun();
  return [
    'compose', ...composeFileArgs(file), 'run', '--rm', '--no-deps', '-T',
    '--entrypoint', 'sh', '--user', '0:0', 'controller', '-c', ROOT_SCRIPT, 'sh', name, verb,
  ];
}

/** Runs one verb as root; `tarFrom` streams that folder in as the plugin. */
export function rootOp(
  name: string,
  verb: 'install' | 'commit' | 'restore' | 'remove' | 'purge-data',
  tarFrom?: string,
): Promise<void> {
  if (!PLUGIN_FOLDER_RE.test(name)) return Promise.reject(new Error(`bad plugin name ${name}`));
  return new Promise((resolveP, rejectP) => {
    const child = spawn('docker', rootRunArgs(name, verb), {
      cwd: getSubwaveHome(),
      stdio: [tarFrom ? 'pipe' : 'ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (d) => { stderr += String(d); });
    let tarFailed: string | null = null;
    if (tarFrom) {
      const tar = spawn('tar', ['-C', tarFrom, '--exclude=./.git', '-cf', '-', '.'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let tarErr = '';
      tar.stderr.on('data', (d) => { tarErr += String(d); });
      tar.stdout.pipe(child.stdin!);
      tar.on('exit', (code) => { if (code !== 0) tarFailed = tarErr.trim() || `tar exited ${code}`; });
    }
    child.on('error', rejectP);
    child.on('exit', (code) => {
      if (tarFailed) return rejectP(new Error(`packing the plugin failed: ${tarFailed}`));
      if (code === 0) return resolveP();
      const tail = stderr.trim().split('\n').filter(Boolean).slice(-3).join(' ');
      rejectP(new Error(`docker compose run exited ${code}${tail ? `: ${tail}` : ''}`));
    });
  });
}

// ---- small formatting ---------------------------------------------------------

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
