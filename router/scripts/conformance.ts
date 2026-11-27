// Plugin conformance kit: runs the contract the station relies on against one
// music-source plugin, through the same enforcement layer the router uses.
//
//   npm run conformance -- <plugin-dir> [--config key=value ...] [--builtin] [--allow-writes] [--json]
//
// Reads only, unless --allow-writes: then it also stars/unstars a track and
// creates, edits and deletes a scratch playlist on the backend.
//
// Exit code 0 = every check passed (warnings allowed), 1 = a check failed.

import { resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { loadPlugin } from '../src/host/loader.js';
import { resolveConfig } from '../src/host/manifest.js';
import { prefixedCodec } from '../src/host/ids.js';
import { wrapPlugin } from '../src/host/wrap.js';
import type { HostSource, SubSong } from '../src/host/types.js';
import type { SourceContext } from '../src/sdk/types.js';

export type Outcome = 'pass' | 'warn' | 'fail' | 'skip';

export interface Check {
  name: string;
  outcome: Outcome;
  detail?: string;
}

export interface Report {
  plugin: string;
  checks: Check[];
  ok: boolean;
}

export interface ConformanceOptions {
  config?: Record<string, string>;
  builtin?: boolean;
  allowWrites?: boolean;
  /** Per-op timeout; real backends get the router's default. */
  opTimeoutMs?: number;
}

const PUBLISHED_ID = /^[\w-]{1,64}$/;
const MIN_AUDIO_BYTES = 4096;

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

async function build(dir: string, opts: ConformanceOptions): Promise<{ name: string; make: () => Promise<HostSource> } | { error: string }> {
  const plugin = await loadPlugin(resolve(dir), opts.builtin ?? false);
  if (plugin.error || !plugin.factory || !plugin.manifest) return { error: plugin.error ?? 'did not load' };
  const manifest = plugin.manifest;
  const resolved = resolveConfig(manifest, opts.config ?? {});
  if (resolved.missing.length) return { error: `missing required config: ${resolved.missing.join(', ')}` };
  const dataDir = mkdtempSync(resolve(tmpdir(), `conformance-${manifest.name}-`));
  const factory = plugin.factory;
  return {
    name: manifest.name,
    make: async () => {
      const ctx: SourceContext = { config: { ...resolved.values }, fetch, log: quiet, dataDir };
      const instance = await factory(ctx);
      return wrapPlugin(instance, { name: manifest.name, label: manifest.label, codec: prefixedCodec(manifest.idPrefix), log: quiet, opTimeoutMs: opts.opTimeoutMs });
    },
  };
}

function idProblems(ids: string[]): string[] {
  return ids.filter((id) => !PUBLISHED_ID.test(id) || id.includes('/'));
}

async function readAtLeast(body: AsyncIterable<Uint8Array> | null, want: number): Promise<number> {
  if (!body) return 0;
  let total = 0;
  const it = body[Symbol.asyncIterator]();
  try {
    while (total < want) {
      const { done, value } = await it.next();
      if (done) break;
      total += value.byteLength;
    }
  } finally {
    await it.return?.();
  }
  return total;
}

export async function runConformance(dir: string, opts: ConformanceOptions = {}): Promise<Report> {
  const checks: Check[] = [];
  const add = (name: string, outcome: Outcome = 'pass', detail?: string) => checks.push({ name, outcome, ...(detail ? { detail } : {}) });
  const step = async (name: string, fn: () => Promise<Outcome | [Outcome, string] | void>) => {
    try {
      const r = await fn();
      if (Array.isArray(r)) add(name, r[0], r[1]);
      else add(name, r ?? 'pass');
    } catch (err) {
      add(name, 'fail', err instanceof Error ? err.message : String(err));
    }
  };

  const built = await build(dir, opts);
  if ('error' in built) {
    add('plugin loads', 'fail', built.error);
    return { plugin: dir, checks, ok: false };
  }
  add('plugin loads');
  const pluginName = built.name;
  let a: HostSource | undefined;
  let b: HostSource | undefined;
  try {
    a = await built.make();
    b = await built.make();
    add('factory builds an instance');
  } catch (err) {
    add('factory builds an instance', 'fail', (err as Error).message);
    return { plugin: built.name, checks, ok: false };
  }

  let albums: Awaited<ReturnType<HostSource['albumList']>> = [];
  let songs: SubSong[] = [];

  await step('health: stats() or genres() answers', async () => {
    if (a.capabilities.stats) {
      const s = await a.stats();
      return ['pass', `${s.artists} artists, ${s.albums} albums, ${s.songs} songs`];
    }
    await a.genres();
    return ['warn', 'no stats() — the admin UI cannot show library counts'];
  });

  await step('albumList returns albums with publishable ids', async () => {
    albums = await a.albumList('alphabeticalByName', 5, 0);
    if (!albums.length) return ['fail', 'the library returned no albums — point the plugin at a library with music in it'];
    const bad = idProblems(albums.flatMap((x) => [x.id, x.coverArt, x.artistId].filter(Boolean)));
    if (bad.length) return ['fail', `unpublishable ids: ${bad.slice(0, 3).join(', ')}`];
  });
  if (!albums.length) return finish();

  await step('ids are stable across two independent instances', async () => {
    const again = await b.albumList('alphabeticalByName', 5, 0);
    const x = albums.map((al) => al.id).join(',');
    const y = again.map((al) => al.id).join(',');
    if (x !== y) return ['fail', 'the same listing produced different ids — ids must be derived from the backend, not generated per run'];
  });

  await step('album(id) resolves with its songs', async () => {
    const hit = await a.album(albums[0]!.id);
    if (!hit) return ['fail', `album ${albums[0]!.id} from albumList did not resolve`];
    songs = hit.songs;
    if (!songs.length) return ['fail', 'album has no songs'];
    const bad = idProblems(songs.flatMap((s) => [s.id, s.albumId, s.artistId, s.coverArt].filter(Boolean)));
    if (bad.length) return ['fail', `unpublishable ids: ${bad.slice(0, 3).join(', ')}`];
    const missing = songs.filter((s) => !s.title || !s.duration);
    if (missing.length) return ['warn', `${missing.length} song(s) lack a title or duration`];
  });
  if (!songs.length) return finish();
  const song = songs[0]!;

  await step('song(id) round-trips', async () => {
    const hit = await a.song(song.id);
    if (!hit) return ['fail', `song ${song.id} did not resolve`];
    if (hit.id !== song.id) return ['fail', `asked for ${song.id}, got ${hit.id}`];
  });

  await step('an unknown id is undefined, not an error', async () => {
    const hit = await a.song(`${song.id.split(/[-_]/)[0]}-conformance-no-such-id`);
    if (hit !== undefined) return ['fail', 'returned a song for an id that does not exist'];
  });

  await step('artist(id) resolves', async () => {
    if (!song.artistId && !albums[0]!.artistId) return ['warn', 'songs carry no artistId'];
    const hit = await a.artist(song.artistId || albums[0]!.artistId);
    if (!hit) return ['warn', 'artistId did not resolve to an artist'];
  });

  await step('search finds a known song by title', async () => {
    const hit = await a.search(song.title, { artistCount: 5, albumCount: 5, songCount: 20 });
    if (!hit.songs.length) return ['warn', `searching "${song.title}" returned no songs`];
  });

  await step('genres and songsByGenre', async () => {
    const genres = await a.genres();
    if (!genres.length) return ['warn', 'no genres — genre-locked shows will fall back to random picks'];
    const pick = song.genre || genres[0]!.value;
    const byGenre = await a.songsByGenre(pick, 5, 0);
    if (!byGenre.length) return ['warn', `songsByGenre("${pick}") returned nothing`];
  });

  await step('randomSongs', async () => {
    const r = await a.randomSongs(5, {});
    if (!r.length) return ['fail', 'randomSongs returned nothing — the station falls back on it'];
  });

  await step('stream returns audio (≥ 4 KiB, not text)', async () => {
    const s = await a.stream(song.id, undefined);
    if (!s) return ['fail', 'stream() returned undefined for a known song'];
    const got = await readAtLeast(s.body, MIN_AUDIO_BYTES);
    if (got < MIN_AUDIO_BYTES) return ['fail', `only ${got} bytes arrived — Liquidsoap rejects anything under 4 KiB`];
    return ['pass', `${s.headers['content-type']}, HTTP ${s.status}`];
  });

  await step('stream honours Range when it can', async () => {
    const s = await a.stream(song.id, 'bytes=0-1023');
    if (!s) return ['fail', 'stream() returned undefined with a Range header'];
    await readAtLeast(s.body, 1);
    return s.status === 206 ? 'pass' : ['warn', `answered ${s.status} to a Range request (fine for generated audio)`];
  });

  await step('coverArt returns an image', async () => {
    const art = (await a.coverArt(song.coverArt, 300)) ?? (await a.coverArt(song.id, 300));
    if (!art) return ['warn', 'no art for the first song or its album'];
    if (!art.contentType.startsWith('image/')) return ['warn', `art content-type is ${art.contentType}`];
  });

  // --- optional ops: checked only when the plugin claims them ---
  const caps = a.capabilities;
  const optional = async (cap: keyof typeof caps, name: string, fn: () => Promise<Outcome | [Outcome, string] | void>) => {
    if (!caps[cap]) return add(name, 'skip', 'not implemented');
    await step(name, fn);
  };

  await optional('artists', 'artists() lists the library', async () => {
    const list = await a.artists();
    if (!list.length) return ['fail', 'artists() returned nothing'];
    const bad = idProblems(list.map((x) => x.id));
    if (bad.length) return ['fail', `unpublishable ids: ${bad.slice(0, 3).join(', ')}`];
  });
  await optional('similarSongs', 'similarSongs answers', async () => {
    const list = await a.similarSongs(song.id, 5);
    return list.length ? 'pass' : ['warn', 'no similar songs for the first track'];
  });
  await optional('topSongs', 'topSongs answers', async () => {
    await a.topSongs(song.artist, 5);
  });
  await optional('lyrics', 'lyrics answers (lines or null)', async () => {
    const l = await a.lyrics(song.id);
    if (l === undefined) return ['fail', 'lyrics() said a known song does not exist'];
  });
  await optional('stars', 'starred() answers', async () => {
    await a.starred();
  });
  await optional('playlists', 'playlists() answers', async () => {
    await a.playlists();
  });
  await optional('scanStatus', 'scanStatus() answers', async () => {
    const s = await a.scanStatus();
    if (!s) return ['fail', 'scanStatus() returned nothing'];
  });

  if (opts.allowWrites) {
    await optional('stars', 'star → starred → unstar', async () => {
      await a.star([song.id]);
      const after = await a.starred();
      await a.unstar([song.id]);
      if (!after.has(song.id)) return ['fail', 'a starred song was not in starred()'];
    });
    await optional('playlists', 'playlist create → update → delete', async () => {
      const pl = await a.createPlaylist('SUB/WAVE conformance (safe to delete)', [song.id]);
      try {
        if (!pl.songs.some((s) => s.id === song.id)) return ['fail', 'created playlist does not contain its song'];
        const updated = await a.updatePlaylist(pl.id, { comment: 'conformance' });
        if (!updated) return ['fail', 'updatePlaylist lost the playlist'];
      } finally {
        await a.deletePlaylist(pl.id);
      }
    });
  } else {
    add('write ops (stars, playlists)', 'skip', 'pass --allow-writes to exercise them');
  }

  return finish();

  function finish(): Report {
    void a?.close();
    void b?.close();
    return { plugin: pluginName, checks, ok: !checks.some((c) => c.outcome === 'fail') };
  }
}

function parseArgs(argv: string[]): { dir?: string; opts: ConformanceOptions; json: boolean } {
  const opts: ConformanceOptions = { config: {} };
  let dir: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--config') {
      const kv = argv[++i] ?? '';
      const eq = kv.indexOf('=');
      if (eq > 0) opts.config![kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (arg === '--builtin') opts.builtin = true;
    else if (arg === '--allow-writes') opts.allowWrites = true;
    else if (arg === '--json') json = true;
    else dir = arg;
  }
  return { dir, opts, json };
}

const MARK: Record<Outcome, string> = { pass: '✓', warn: '!', fail: '✗', skip: '-' };

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const { dir, opts, json } = parseArgs(process.argv.slice(2));
  if (!dir) {
    console.error('usage: npm run conformance -- <plugin-dir> [--config key=value ...] [--builtin] [--allow-writes] [--json]');
    process.exit(2);
  }
  const report = await runConformance(dir, opts);
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`\nConformance: ${report.plugin}\n`);
    for (const c of report.checks) console.log(`  ${MARK[c.outcome]} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
    console.log(`\n${report.ok ? 'PASS' : 'FAIL'}\n`);
  }
  process.exit(report.ok ? 0 : 1);
}
