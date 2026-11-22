// Why blocked tracks keep their library rows (the Library counts line,
// music/library-overview.ts, relies on it: `library` holds them, and the
// music-server count walks with `includeBlocked` to compare like with like).
//
// The tag and analyse walks run in child processes (broadcast/tagger.ts spawns
// music/tag-library.ts and music/analyze-library.ts) that never call
// blocklist.load(). There rejectBlocked() is the identity, so the walk sees
// blocked songs, they land in the walk's live ids, and pruneMissingTracks()
// keeps their rows. Loaded, the same walk would drop them and the prune would
// delete every blocked row. This file is its own process, like the child: it
// writes a real blocklist.json and never loads it until the last step.
//
// Run: npm test -- walk-keeps-blocked-rows

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { removeTempDir } from './test-utils/temp-dir.js';

const STATE = mkdtempSync(join(tmpdir(), 'subwave-walk-blocked-'));
const ALBUMS = ['al0', 'al1'];
const SONGS = ALBUMS.flatMap(a => [`${a}-s0`, `${a}-s1`]);

const navi = express();
navi.get('/rest/:endpoint', (req, res) => {
  const body = (b: Record<string, unknown>) => res.json({ 'subsonic-response': { status: 'ok', version: '1.16.1', ...b } });
  if (req.params.endpoint === 'getAlbumList2') {
    const album = Number(req.query.offset ?? 0) > 0 ? [] : ALBUMS.map(id => ({ id, name: `Album ${id}`, artist: `Artist ${id}` }));
    return body({ albumList2: { album } });
  }
  if (req.params.endpoint === 'getAlbum') {
    const id = String(req.query.id);
    return body({
      album: {
        id, name: `Album ${id}`, artist: `Artist ${id}`, isCompilation: false,
        song: [0, 1].map(i => ({ id: `${id}-s${i}`, title: `Song ${i}`, artist: `Artist ${id}`, album: `Album ${id}`, albumId: id, duration: 180, suffix: 'mp3' })),
      },
    });
  }
  return body({});
});
const naviServer: Server = createServer(navi);
await new Promise<void>(r => naviServer.listen(0, '127.0.0.1', r));

process.env.STATE_DIR = STATE;
process.env.NAVIDROME_URL = `http://127.0.0.1:${(naviServer.address() as AddressInfo).port}`;
process.env.NAVIDROME_USER = 'tester';
process.env.NAVIDROME_PASS = 'tester';

// The operator's list, on disk where the child would find it: one album, one track.
writeFileSync(join(STATE, 'blocklist.json'), JSON.stringify({
  entries: [
    { type: 'album', id: 'al1', name: 'Album al1' },
    { type: 'track', id: 'al0-s0', name: 'Song 0' },
  ],
  rules: [],
}));

const db = await import('../src/music/library-db.js');
await db.open({ embeddingDim: 8, adoptStoredDim: true });
const subsonic = await import('../src/music/subsonic.js');
const blocklist = await import('../src/music/blocklist.js');

after(async () => {
  db.close();
  await new Promise<void>(r => naviServer.close(() => r()));
  await removeTempDir(STATE);
});

async function walkIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  for await (const s of subsonic.iterateAllSongs({ requireComplete: true })) ids.add(s.id);
  return ids;
}

test('a walk without the blocklist loaded keeps blocked ids live, so the prune keeps their rows', async () => {
  const ins = db.getDb()!.prepare('INSERT INTO tracks (id, title, artist, album) VALUES (?, ?, ?, ?)');
  for (const id of SONGS) ins.run(id, id, 'a', 'b');

  assert.equal(blocklist.isEmpty(), true, 'not loaded, as in the tagger child');
  const live = await walkIds();
  assert.deepEqual([...live].sort(), [...SONGS].sort(), 'the walk sees blocked songs');
  assert.equal(db.pruneMissingTracks(live), 0);
  const rows = (db.getDb()!.prepare('SELECT id FROM tracks ORDER BY id').all() as Array<{ id: string }>).map(r => r.id);
  assert.deepEqual(rows, [...SONGS].sort(), 'blocked rows survive the prune');

  // The contrast that makes the above load-bearing: loaded, the same walk
  // drops them, and a prune over its ids would delete their rows.
  await blocklist.load();
  const loadedLive = await walkIds();
  assert.deepEqual([...loadedLive].sort(), ['al0-s1']);
});

test('only the main process loads the blocklist: the walk children never do', () => {
  const src = fileURLToPath(new URL('../src/', import.meta.url));
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) files.push(p);
    }
  };
  walk(src);
  const callers = files
    .filter(f => /\bblocklist\.load\(/.test(readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '')))
    .map(f => relative(src, f).replace(/\\/g, '/'))
    .sort();
  // server.ts boots the main process; scene-references.ts is reached only
  // from admin routes. A new caller reachable from music/tag-library.ts or
  // music/analyze-library.ts would make every tag run prune blocked rows,
  // and the Library page would then report them as "new tracks to import".
  assert.deepEqual(callers, ['music/scene-references.ts', 'server.ts']);
});
