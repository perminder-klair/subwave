// GET /library/untagged keeps paging past a tagged stretch longer than its
// per-request scan budget.
//
// The walk caps each request at 5,000 visited songs. It used to end that walk
// with nextCursor: null — the same value as "end of library" — so once the
// first ~5,000 songs of the alphabetical walk were tagged (which is exactly
// what a partial bulk-tagger run leaves, since it walks the same order), the
// Needs-tags tab showed nothing and offered no Load more. Also pinned: a
// negative cursor is clamped rather than failing the request.
//
// Real library.db in a temp state dir; Navidrome is a loopback fake.
//
// Run: `npm test -- library-untagged-paging`.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTempDir } from './test-utils/temp-dir.js';

const ALBUMS = 30;
const PER_ALBUM = 200; // 6,000 songs
const TAGGED = 5_200;  // more than one request's scan budget

const songId = (n: number) => `s${String(n).padStart(5, '0')}`;
const albumId = (a: number) => `a${String(a).padStart(3, '0')}`;

const navidrome = createServer((req, res) => {
  const url = new URL(req.url!, 'http://fake');
  const sub: Record<string, unknown> = { status: 'ok' };
  switch (url.pathname.split('/').at(-1)) {
    case 'getAlbumList2': {
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const size = Number(url.searchParams.get('size') ?? 0);
      const album: { id: string }[] = [];
      for (let a = offset; a < Math.min(ALBUMS, offset + size); a++) album.push({ id: albumId(a) });
      sub.albumList2 = { album };
      break;
    }
    case 'getAlbum': {
      const a = Number(url.searchParams.get('id')!.slice(1));
      const song: Record<string, string>[] = [];
      for (let k = 0; k < PER_ALBUM; k++) {
        const n = a * PER_ALBUM + k;
        song.push({ id: songId(n), title: `Song ${n}`, artist: 'Artist', album: `Album ${a}`, albumId: albumId(a) });
      }
      sub.album = { id: albumId(a), song };
      break;
    }
    default:
      break;
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ 'subsonic-response': sub }));
});
await new Promise<void>((r) => { navidrome.listen(0, '127.0.0.1', () => r()); });
navidrome.unref();

const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-untagged-'));
process.env.STATE_DIR = stateRoot;
process.env.NAVIDROME_URL = `http://127.0.0.1:${(navidrome.address() as any).port}`;
process.env.NAVIDROME_USER = 'test';
process.env.NAVIDROME_PASS = 'test';
delete process.env.ADMIN_USER;
delete process.env.ADMIN_PASS;

const express = (await import('express')).default;
const library = await import('../src/music/library.js');
const db = await import('../src/music/library-db.js');
const { router } = await import('../src/routes/library/maintenance.js');
const { encodeCursor, decodeCursor } = await import('../src/routes/library/params.js');

await library.load();
for (let n = 0; n < TAGGED; n++) {
  db.upsertTrackMeta(songId(n), { title: `Song ${n}`, artist: 'Artist' });
  db.upsertTrackTags(songId(n), { moods: ['warm'], energy: 'medium', source: 'manual', confidence: 1 });
}

const app = express();
app.use(router);
const server = createServer(app);
await new Promise<void>((r) => { server.listen(0, '127.0.0.1', () => r()); });
server.unref();
const base = `http://127.0.0.1:${(server.address() as any).port}`;

async function page(cursor?: string) {
  const qs = new URLSearchParams({ limit: '50' });
  if (cursor) qs.set('cursor', cursor);
  const res = await fetch(`${base}/library/untagged?${qs}`, { signal: AbortSignal.timeout(30_000) });
  assert.equal(res.status, 200);
  return await res.json() as { rows: { id: string }[]; nextCursor: string | null };
}

test('a spent scan budget hands back a cursor, and paging reaches the untagged remainder', async () => {
  const first = await page();
  assert.equal(first.rows.length, 0, 'the first 5,000 songs are all tagged');
  assert.notEqual(first.nextCursor, null, 'budget exhaustion must not read as end of walk');
  assert.deepEqual(decodeCursor(first.nextCursor!), { albumOffset: 25, songIndex: 0 });

  const seen: string[] = [];
  let cursor: string | null = first.nextCursor;
  let pages = 0;
  while (cursor && pages++ < 50) {
    const p = await page(cursor);
    seen.push(...p.rows.map((r) => r.id));
    cursor = p.nextCursor;
  }
  assert.equal(cursor, null, 'the walk ends');
  assert.equal(seen.length, ALBUMS * PER_ALBUM - TAGGED);
  assert.equal(new Set(seen).size, seen.length, 'no song is listed twice');
  assert.equal(seen[0], songId(TAGGED));
  assert.equal(seen.at(-1), songId(ALBUMS * PER_ALBUM - 1));
});

test('a negative cursor is clamped to the start of the walk', async () => {
  assert.deepEqual(decodeCursor(encodeCursor({ albumOffset: -3, songIndex: -1 })), { albumOffset: 0, songIndex: 0 });
  const p = await page(encodeCursor({ albumOffset: 0, songIndex: -1 }));
  assert.equal(p.rows.length, 0);
  assert.notEqual(p.nextCursor, null);
});
