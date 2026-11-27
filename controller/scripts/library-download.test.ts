// The admin Library download (routes/library/download.ts): an admin names a
// selection (ticked ids, the Browse list's filter, or the Liked list), gets a
// signed link, and the link streams one original file or a STORED zip built as
// it goes, from a fake Subsonic server on a real socket. The archives are
// checked by Python's zipfile (CRCs included) and, when installed, `unzip -t`.
//
// Run: npm test -- library-download

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, beforeEach } from 'node:test';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';
import { listen } from './test-utils/http.js';

const dir = createTempDir(join(tmpdir(), 'subwave-library-download-'));
process.env.STATE_DIR = dir;
process.env.ADMIN_USER = 'download-admin';
process.env.ADMIN_PASS = 'download-pass';

// The likes store, as the station wrote it: hearts on mirror tracks, one on an
// id a re-import left behind (`stale-old`: neither the mirror nor the music
// server knows it), one on the station's own archive (the Liked view hides it).
const like = (songId: string, likedAt: string, n: number, track: Record<string, unknown> = {}) =>
  Array.from({ length: n }, (_, i) => ({
    songId, track: { id: songId, title: songId, ...track }, airingKey: `${songId}|${i}`,
    listenerKey: `l${i}`, likedAt,
  }));
writeFileSync(join(dir, 'likes.json'), JSON.stringify({
  secret: 'test-secret',
  likes: [
    ...like('a3', '2026-01-01T00:00:00.000Z', 3, { artist: 'Cee', title: 'Party' }),
    ...like('stale-old', '2026-01-02T00:00:00.000Z', 1, { artist: 'Old Artist', title: 'Old Title' }),
    ...like('mp3', '2026-01-03T00:00:00.000Z', 2, { artist: 'Eff', title: 'AC/DC: "Live"?' }),
    ...like('a2', '2026-01-04T00:00:00.000Z', 1, { artist: 'Bee', title: 'Calm Two' }),
    ...like('archive', '2026-01-05T00:00:00.000Z', 1, { title: '13-00' }),
    ...like('a1', '2026-01-06T00:00:00.000Z', 1, { artist: 'Ane', title: 'Calm One' }),
  ],
}));

const { config } = await import('../src/config.js');
const express = (await import('express')).default;
const library = await import('../src/music/library.js');
const db = await import('../src/music/library-db.js');
const { router: browseRoutes } = await import('../src/routes/library/browse.js');
const { router: downloadRoutes, _setListDownloadCap } = await import('../src/routes/library/download.js');
const { LIBRARY_DOWNLOAD_LIST_MAX } = await import('../src/schemas/library-download.js');
const { browseListNarrowed, listDownloadRefusal } = await import('../src/music/download-policy.js');
const { signLink } = await import('../src/util/signed-link.js');
const { StoreZipWriter, dosDateTime } = await import('../src/util/zip-stream.js');
const names = await import('../src/music/download-names.js');

// ── Fake music server ────────────────────────────────────────────────────────
const audio = (id: string, n = 3000) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 7 + id.charCodeAt(0)) % 256));
const fake = {
  requests: [] as Array<{ path: string; id: string | null; range: string | undefined }>,
  slowClosed: false,
};
const errorDoc = (res: import('node:http').ServerResponse, code: number) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(`{"subsonic-response":{"status":"failed","error":{"code":${code}}}}`);
};
const nd = await listen((req, res) => {
  const u = new URL(req.url || '/', 'http://x');
  const id = u.searchParams.get('id') || '';
  fake.requests.push({ path: u.pathname, id, range: req.headers.range });
  const isDownload = u.pathname === '/rest/download';
  const isRawStream = u.pathname === '/rest/stream' && u.searchParams.get('format') === 'raw';
  if (u.pathname === '/rest/getSong') {
    // The music server knows every seeded id; an id a re-import retired is gone.
    if (id === 'stale-old') return errorDoc(res, 70);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(`{"subsonic-response":{"status":"ok","song":{"id":${JSON.stringify(id)},"title":"x"}}}`);
  }
  if (!isDownload && !isRawStream) { res.writeHead(404); return res.end(); }
  if (id === 'gone' || id === 'stale-old') return errorDoc(res, 70);
  // A server with downloads switched off: `download` refuses, `stream` serves.
  if (id === 'refused' && isDownload) return errorDoc(res, 50);
  if (id === 'slow') {
    res.writeHead(200, { 'Content-Type': 'audio/flac' });
    const t = setInterval(() => res.write(Buffer.alloc(4096, 1)), 10);
    res.on('close', () => { clearInterval(t); fake.slowClosed = true; });
    return;
  }
  if (id === 'broken') {
    res.writeHead(200, { 'Content-Type': 'audio/flac', 'Content-Length': '100000' });
    res.write(Buffer.alloc(5000, 2));
    setTimeout(() => res.destroy(), 30);
    return;
  }
  const body = audio(id);
  const head: Record<string, string> = {
    'Content-Type': id === 'mp3' ? 'audio/mpeg' : 'audio/flac',
    'Accept-Ranges': 'bytes',
    'Last-Modified': 'Tue, 03 Mar 2026 10:20:30 GMT',
  };
  if (isDownload) head['Content-Disposition'] = `attachment; filename="${id}.${id === 'mp3' ? 'mp3' : 'flac'}"`;
  const m = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range || ''));
  if (m) {
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : body.length - 1;
    res.writeHead(206, { ...head, 'Content-Range': `bytes ${from}-${to}/${body.length}`, 'Content-Length': String(to - from + 1) });
    return res.end(body.subarray(from, to + 1));
  }
  res.writeHead(200, { ...head, 'Content-Length': String(body.length) });
  res.end(body);
});
nd.server.unref();
config.navidrome.url = nd.url;

// ── Library mirror ───────────────────────────────────────────────────────────
await library.load();
type Seed = { id: string; artist: string; title: string; album?: string; moods: string[]; suffix?: string | null; size?: number | null };
const SEEDS: Seed[] = [
  { id: 'a1', artist: 'Ane', title: 'Calm One', moods: ['calm'], suffix: 'flac', size: 3000 },
  { id: 'a2', artist: 'Bee', title: 'Calm Two', moods: ['calm', 'dreamy'], suffix: 'flac', size: 3000 },
  { id: 'a3', artist: 'Cee', title: 'Party', moods: ['energetic'], suffix: 'flac', size: 3000 },
  { id: 'a4', artist: 'Dee', title: 'Calm Three', moods: ['calm'], suffix: 'flac', size: 3000 },
  // Same artist and title as a1: the zip must not overwrite one with the other.
  { id: 'a5', artist: 'Ane', title: 'Calm One', moods: ['calm'], suffix: 'flac', size: 3000 },
  { id: 'mp3', artist: 'Eff', title: 'AC/DC: "Live"?', moods: ['calm'], suffix: 'mp3', size: null },
  { id: 'refused', artist: 'Gee', title: 'Refused', moods: ['calm'], suffix: 'flac', size: 3000 },
  { id: 'gone', artist: 'Hai', title: 'Gone', moods: ['dreamy'], suffix: 'flac', size: 1000 },
  { id: 'slow', artist: 'Zed', title: 'Slow', moods: ['dreamy'], suffix: 'flac', size: 1000 },
  { id: 'broken', artist: 'Zed', title: 'Broken', moods: ['dreamy'], suffix: 'flac', size: 1000 },
  { id: 'nosuffix', artist: 'Ida', title: 'No Suffix', moods: ['dreamy'], suffix: null, size: null },
  // An hour of the station's own archive an old tagger wrote (#273): the list hides it.
  { id: 'archive', artist: '', title: '13-00', album: '', moods: ['calm'], suffix: 'mp3', size: 1000 },
];
for (const s of SEEDS) {
  db.upsertTrackMeta(s.id, {
    title: s.title, artist: s.artist, album: s.album ?? 'Album', genres: ['test'], duration: 200,
    fileSuffix: s.suffix ?? null, fileSize: s.size ?? null, filePath: `x/${s.id}.${s.suffix ?? 'bin'}`,
  });
  db.upsertTrackTags(s.id, { moods: s.moods, energy: 'low', source: 'llm' });
}
// Untagged: never in the Browse list, so never in a filter download.
db.upsertTrackMeta('untagged', { title: 'Calm Untagged', artist: 'Ane', album: 'Album', fileSuffix: 'flac' });

const app = express();
app.use(express.json());
app.use(browseRoutes, downloadRoutes);
const { server, url: base } = await listen(app);
server.unref();
after(async () => {
  server.closeAllConnections();
  nd.server.closeAllConnections();
  await removeTempDir(dir);
});

const auth = { Authorization: `Basic ${Buffer.from('download-admin:download-pass').toString('base64')}` };
const json = { ...auth, 'Content-Type': 'application/json' };
async function linkFor(body: unknown) {
  const r = await fetch(`${base}/library/download`, { method: 'POST', headers: json, body: JSON.stringify(body) });
  assert.equal(r.status, 200, await r.clone().text());
  return r.json() as Promise<{ path: string; count: number; bytes: number; unsized: number; name: string; single: boolean }>;
}

// Python's zipfile reads the archive: names, method, sizes, and testzip()
// re-reads every entry against its CRC.
function inspectZip(buf: Buffer): { names: string[]; methods: number[]; sizes: number[]; bad: string | null; contents: Record<string, string> } {
  const f = join(dir, `z-${Math.random().toString(36).slice(2)}.zip`);
  writeFileSync(f, buf);
  const out = execFileSync('python3', ['-c', `
import zipfile, sys, json, base64
z = zipfile.ZipFile(sys.argv[1])
info = z.infolist()
print(json.dumps({
  "names": [i.filename for i in info],
  "methods": [i.compress_type for i in info],
  "sizes": [i.file_size for i in info],
  "bad": z.testzip(),
  "contents": {i.filename: base64.b64encode(z.read(i)).decode() for i in info},
}))
`, f]).toString();
  const unzip = spawnSync('unzip', ['-tqq', f]);
  if (!unzip.error) assert.equal(unzip.status, 0, `unzip -t: ${unzip.stdout}${unzip.stderr}`);
  return JSON.parse(out);
}

beforeEach(() => { fake.requests = []; });

test('only an admin can ask for a download; the body names ids or a filter, never both', async () => {
  assert.equal((await fetch(`${base}/library/download`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ['a1'] }),
  })).status, 401);
  for (const body of [{}, { ids: ['a1'], filter: {} }, { ids: [] }, { ids: ['../etc'] }]) {
    const r = await fetch(`${base}/library/download`, { method: 'POST', headers: json, body: JSON.stringify(body) });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  const none = await fetch(`${base}/library/download`, {
    method: 'POST', headers: json, body: JSON.stringify({ filter: { moods: 'no-such-mood' } }),
  });
  assert.equal(none.status, 400);
  assert.equal(fake.requests.length, 0);
});

test('a forged, swapped, expired or missing signature never reaches the music server', async () => {
  const { path } = await linkFor({ ids: ['a1', 'a2'] });
  const u = new URL(path, 'http://x');
  const token = u.pathname.split('/').pop()!;
  const exp = u.searchParams.get('exp')!;
  const sig = u.searchParams.get('sig')!;
  const past = Math.floor(Date.now() / 1000) - 10;
  for (const p of [
    `/library/download/${token}?exp=${exp}&sig=${sig.slice(0, -2)}xx`,
    `/library/download/${token}?exp=${Number(exp) + 1}&sig=${sig}`,
    `/library/download/${token}`,
    `/library/download/${token}?exp=${past}&sig=${signLink('download', token, past)}`,
    // A preview signature over the same subject is not a download signature.
    `/library/download/${token}?exp=${exp}&sig=${signLink('preview', token, Number(exp))}`,
  ]) {
    assert.equal((await fetch(`${base}${p}`)).status, 403, p);
  }
  // Well signed, but no such selection (a restart, or one evicted).
  const ghost = 'AAAAAAAAAAAAAAAAAAAAAA';
  assert.equal((await fetch(`${base}/library/download/${ghost}?exp=${exp}&sig=${signLink('download', ghost, Number(exp))}`)).status, 404);
  assert.equal(fake.requests.length, 0);
});

test('one ticked track: the original file, saved as Artist - Title.ext, resumable with Range', async () => {
  const link = await linkFor({ ids: ['a1'] });
  assert.equal(link.count, 1);
  assert.equal(link.single, true);
  assert.equal(link.bytes, 3000);
  assert.equal(link.name, 'Ane - Calm One.flac');
  assert.match(link.path, /^\/library\/download\/[\w-]+\?exp=\d+&sig=[\w-]+$/);
  const r = await fetch(`${base}${link.path}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'audio/flac');
  assert.equal(r.headers.get('content-length'), '3000');
  assert.equal(r.headers.get('content-disposition'),
    `attachment; filename="Ane - Calm One.flac"; filename*=UTF-8''Ane%20-%20Calm%20One.flac`);
  assert.match(String(r.headers.get('cache-control')), /no-store/);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), audio('a1'));
  assert.deepEqual(fake.requests.map(q => [q.path, q.id]), [['/rest/download', 'a1']]);

  const part = await fetch(`${base}${link.path}`, { headers: { Range: 'bytes=1000-' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 1000-2999/3000');
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), audio('a1').subarray(1000));
});

test('a server that refuses downloads still serves the original bytes through stream format=raw', async () => {
  const { path } = await linkFor({ ids: ['refused'] });
  const r = await fetch(`${base}${path}`);
  assert.equal(r.status, 200);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), audio('refused'));
  assert.deepEqual(fake.requests.map(q => q.path), ['/rest/download', '/rest/stream']);
});

test('one track the server does not have is a 404, not an error document saved as audio', async () => {
  const { path } = await linkFor({ ids: ['gone'] });
  assert.equal((await fetch(`${base}${path}`)).status, 404);
});

test('several ticked tracks: one valid STORED zip, in order, names de-duplicated, sizes summed', async () => {
  const link = await linkFor({ ids: ['a1', 'a5', 'mp3', 'nosuffix', 'a1'] });
  // The repeated a1 is one track.
  assert.equal(link.count, 4);
  assert.equal(link.single, false);
  assert.equal(link.bytes, 6000);
  assert.equal(link.unsized, 2);
  assert.match(link.name, /^library-4-tracks-\d{4}-\d{2}-\d{2}\.zip$/);
  const r = await fetch(`${base}${link.path}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/zip');
  assert.match(String(r.headers.get('content-disposition')), /^attachment; filename="library-4-tracks-[\d-]+\.zip"/);
  const z = inspectZip(Buffer.from(await r.arrayBuffer()));
  assert.equal(z.bad, null);
  assert.deepEqual(z.names, [
    'Ane - Calm One.flac',
    'Ane - Calm One (2).flac',
    "Eff - AC-DC- 'Live'_.mp3",
    // No suffix in the mirror: the music server's file name gives it.
    'Ida - No Suffix.flac',
  ]);
  assert.deepEqual(z.methods, [0, 0, 0, 0]);
  assert.deepEqual(Buffer.from(z.contents['Ane - Calm One.flac'], 'base64'), audio('a1'));
  assert.deepEqual(Buffer.from(z.contents['Ane - Calm One (2).flac'], 'base64'), audio('a5'));
  assert.deepEqual(fake.requests.map(q => q.id), ['a1', 'a5', 'mp3', 'nosuffix']);
});

test('the whole displayed list: every page of the Browse filter, in its order, nothing else', async () => {
  const filter = { moods: 'calm', sort: 'title' };
  const listed: Array<{ artist: string; title: string }> = [];
  for (let offset = 0; ; offset += 2) {
    const r = await fetch(`${base}/library/browse?${new URLSearchParams({ ...filter, limit: '2', offset: String(offset) })}`, { headers: auth });
    const page = await r.json() as { total: number; rows: Array<{ artist: string; title: string }> };
    listed.push(...page.rows);
    if (offset + 2 >= page.total) break;
  }
  assert.ok(listed.length > 2, 'the list spans several pages');
  const link = await linkFor({ filter });
  assert.equal(link.count, listed.length);
  const z = inspectZip(Buffer.from(await (await fetch(`${base}${link.path}`)).arrayBuffer()));
  assert.equal(z.bad, null);
  const used = new Set<string>(['_missing.txt']);
  assert.deepEqual(
    z.names,
    listed.map(t => names.uniqueName(names.trackFileName({ id: '', ...t, fileSuffix: /AC\/DC/.test(t.title) ? 'mp3' : 'flac' }), used)),
  );
  assert.ok(!z.names.some(n => /Untagged|Party/.test(n)));

  // A query in the search box narrows it exactly as it narrows the list.
  const q = await linkFor({ filter: { q: 'artist:Ane' } });
  assert.equal(q.count, 2);
});

test('a track the server cannot serve is skipped and listed in _missing.txt; the rest still arrive', async () => {
  const { path } = await linkFor({ ids: ['a2', 'gone', 'refused'] });
  const z = inspectZip(Buffer.from(await (await fetch(`${base}${path}`)).arrayBuffer()));
  assert.equal(z.bad, null);
  assert.deepEqual(z.names, ['Bee - Calm Two.flac', 'Gee - Refused.flac', '_missing.txt']);
  const text = Buffer.from(z.contents['_missing.txt'], 'base64').toString('utf8');
  assert.match(text, /^1 track could not be fetched/);
  assert.match(text, /Hai - Gone\.flac {2}\[id gone\]: the music server does not have this track/);
});

test('a track failing after its first byte drops the connection, and no later track is fetched', async () => {
  const { path } = await linkFor({ ids: ['a2', 'broken', 'a4'] });
  const r = await fetch(`${base}${path}`);
  assert.equal(r.status, 200);
  await assert.rejects(r.arrayBuffer());
  await new Promise(res => setTimeout(res, 100));
  assert.deepEqual(fake.requests.map(q => q.id), ['a2', 'broken']);
});

test('the browser going away aborts the track being fetched and fetches no other', async () => {
  fake.slowClosed = false;
  const { path } = await linkFor({ ids: ['slow', 'a1', 'a2'] });
  const ctl = new AbortController();
  const r = await fetch(`${base}${path}`, { signal: ctl.signal });
  const reader = r.body!.getReader();
  let got = 0;
  while (got < 20_000) got += (await reader.read()).value?.length ?? 0;
  ctl.abort();
  for (let i = 0; i < 50 && !fake.slowClosed; i++) await new Promise(res => setTimeout(res, 20));
  assert.equal(fake.slowClosed, true, 'the upstream request was aborted');
  await new Promise(res => setTimeout(res, 100));
  assert.deepEqual(fake.requests.map(q => q.id), ['slow']);
});

// ── The Liked list ───────────────────────────────────────────────────────────
// Every page of GET /library/liked for one sort, as the Liked view shows it.
async function likedPages(sort: string) {
  const listed: Array<{ id: string; artist: string | null; title: string | null }> = [];
  for (let offset = 0; ; offset += 2) {
    const r = await fetch(`${base}/library/liked?${new URLSearchParams({ sort, limit: '2', offset: String(offset) })}`, { headers: auth });
    assert.equal(r.status, 200);
    const page = await r.json() as { total: number; rows: typeof listed };
    listed.push(...page.rows);
    if (offset + 2 >= page.total) break;
  }
  return listed;
}

test('liked: only an admin, and the body names one of ids, filter or liked', async () => {
  assert.equal((await fetch(`${base}/library/download`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ liked: {} }),
  })).status, 401);
  for (const body of [
    { liked: {}, ids: ['a1'] }, { liked: {}, filter: {} }, { liked: true }, { liked: { sort: 'bogus' } },
    { liked: { sort: 'recent', page: 2 } },
  ]) {
    const r = await fetch(`${base}/library/download`, { method: 'POST', headers: json, body: JSON.stringify(body) });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal(fake.requests.length, 0);
});

test('liked: every liked track across the pages, in the view\'s order; a stale heart lands in _missing.txt', async () => {
  for (const sort of ['recent', 'count', 'artist']) {
    const listed = await likedPages(sort);
    assert.ok(listed.length > 2, 'the list spans several pages');
    const link = await linkFor({ liked: { sort } });
    assert.equal(link.count, listed.length, sort);
    assert.match(link.name, new RegExp(`^library-${listed.length}-tracks-`));
    fake.requests = [];
    const z = inspectZip(Buffer.from(await (await fetch(`${base}${link.path}`)).arrayBuffer()));
    assert.equal(z.bad, null);
    // Fetched in the view's order, the archive row hidden as the view hides it.
    assert.deepEqual(fake.requests.filter(q => q.path === '/rest/download').map(q => q.id), listed.map(t => t.id), sort);
    assert.ok(!listed.some(t => t.id === 'archive'));
    const served = listed.filter(t => t.id !== 'stale-old');
    const used = new Set<string>(['_missing.txt']);
    assert.deepEqual(z.names, [
      ...served.map(t => names.uniqueName(names.trackFileName({ id: t.id, artist: t.artist, title: t.title, fileSuffix: t.id === 'mp3' ? 'mp3' : 'flac' }), used)),
      '_missing.txt',
    ], sort);
    // Named from the heart's own snapshot: the mirror no longer knows the id.
    const text = Buffer.from(z.contents['_missing.txt'], 'base64').toString('utf8');
    assert.match(text, /^1 track could not be fetched/);
    assert.match(text, /Old Artist - Old Title {2}\[id stale-old\]/);
  }
  assert.deepEqual((await likedPages('recent')).map(t => t.id), ['a1', 'a2', 'mp3', 'stale-old', 'a3']);
  assert.deepEqual((await likedPages('count')).map(t => t.id), ['a3', 'mp3', 'a1', 'a2', 'stale-old']);
  // No sort named: the view's default, most recent first.
  assert.equal((await linkFor({ liked: {} })).count, 5);
});

test('liked: one track no longer in the library is a 404 JSON, and no link is minted', async () => {
  for (const body of [{ ids: ['stale-old'] }, { liked: { q: 'old title' } }]) {
    fake.requests = [];
    const r = await fetch(`${base}/library/download`, { method: 'POST', headers: json, body: JSON.stringify(body) });
    assert.equal(r.status, 404, JSON.stringify(body));
    const j = await r.json() as { error: string; path?: string };
    assert.match(j.error, /no longer in the library/);
    assert.equal(j.path, undefined);
    assert.ok(!fake.requests.some(q => q.path === '/rest/download' || q.path === '/rest/stream'));
  }
  // One liked track the library still holds: its original file.
  const one = await linkFor({ liked: { q: 'calm one' } });
  assert.equal(one.single, true);
  assert.equal(one.name, 'Ane - Calm One.flac');
});

// ── The whole-list guard: never the whole library by accident ────────────────
async function refused(body: unknown) {
  fake.requests = [];
  const r = await fetch(`${base}/library/download`, { method: 'POST', headers: json, body: JSON.stringify(body) });
  const j = await r.json() as { error: string; count?: number; cap?: number; path?: string };
  assert.equal(j.path, undefined, 'no link is minted');
  assert.equal(fake.requests.length, 0, 'the music server is never asked');
  return { status: r.status, ...j };
}

test('list guard: an unfiltered Browse list is refused, whatever its sort', async () => {
  for (const filter of [{}, { sort: 'title' }, { q: '   ' }, { moods: '' }, { genre: '' }]) {
    const r = await refused({ filter });
    assert.equal(r.status, 400, JSON.stringify(filter));
    assert.match(r.error, /narrow the list/i, JSON.stringify(filter));
    assert.equal(r.cap, LIBRARY_DOWNLOAD_LIST_MAX);
  }
  // Any one narrowing is enough.
  for (const filter of [{ moods: 'calm' }, { energy: 'low' }, { genre: 'test' }, { q: 'artist:Ane' }]) {
    assert.ok((await linkFor({ filter })).count > 0, JSON.stringify(filter));
  }
});

test('list guard: a list above the cap is refused with its count and the cap; ticked ids are not capped', async () => {
  assert.equal(LIBRARY_DOWNLOAD_LIST_MAX, 2_000);
  _setListDownloadCap(3);
  try {
    // calm: a1, a2, a4, a5, mp3, refused (the archive hour is hidden).
    const browse = await refused({ filter: { moods: 'calm' } });
    assert.deepEqual([browse.status, browse.count, browse.cap], [400, 6, 3]);
    assert.match(browse.error, /6 tracks.*3/);
    const liked = await refused({ liked: { sort: 'count' } });
    assert.deepEqual([liked.status, liked.count, liked.cap], [400, 5, 3]);
    // At the cap exactly: allowed.
    assert.equal((await linkFor({ filter: { moods: 'calm', q: 'artist:Ane' } })).count, 2);
    _setListDownloadCap(5);
    assert.equal((await linkFor({ liked: {} })).count, 5);
    // Ticked rows keep their own limit (LIBRARY_DOWNLOAD_IDS_MAX), not the list cap.
    _setListDownloadCap(1);
    assert.equal((await linkFor({ ids: ['a1', 'a2', 'a3', 'a4', 'a5', 'mp3'] })).count, 6);
  } finally {
    _setListDownloadCap(LIBRARY_DOWNLOAD_LIST_MAX);
  }
});

test('list guard policy: what narrows a Browse list, and the refusals', () => {
  const opts = (o: Record<string, unknown> = {}) => ({
    moods: [], energy: null, genre: null, vocal: null, yearFrom: null, yearTo: null, query: null, sort: 'artist', ...o,
  });
  assert.equal(browseListNarrowed(opts()), false);
  assert.equal(browseListNarrowed(opts({ sort: 'year' })), false);
  for (const o of [{ moods: ['calm'] }, { energy: 'low' }, { genre: 'Jazz' }, { vocal: 'vocal' },
    { yearFrom: 1990 }, { yearTo: 1999 }, { query: { kind: 'text' } }]) {
    assert.equal(browseListNarrowed(opts(o)), true, JSON.stringify(o));
  }
  assert.equal(listDownloadRefusal({ narrowed: true, count: 2_000, cap: 2_000 }), null);
  assert.deepEqual(listDownloadRefusal({ narrowed: true, count: 2_001, cap: 2_000 }), {
    error: 'this list holds 2,001 tracks; a whole list downloads at most 2,000: narrow it or tick the tracks to take',
    count: 2_001, cap: 2_000,
  });
  assert.deepEqual(listDownloadRefusal({ narrowed: false, count: null, cap: 2_000 }), {
    error: 'narrow the list first (a search or a filter), or tick the tracks to take: the whole library never downloads at once',
    cap: 2_000,
  });
});

// ── The zip writer itself ────────────────────────────────────────────────────
async function writeZip(fill: (z: InstanceType<typeof StoreZipWriter>) => Promise<void>, opts?: { forceZip64?: boolean }) {
  const parts: Buffer[] = [];
  const z = new StoreZipWriter(async c => { parts.push(c); }, opts);
  await fill(z);
  await z.finish();
  return Buffer.concat(parts);
}

test('zip writer: the ZIP64 forms (local extra, 8-byte descriptors, end record) read back intact', async () => {
  const buf = await writeZip(async z => {
    await z.add('a.flac', [Buffer.from('hello'), Buffer.from(' world')], { size: 11 });
    await z.add('b.flac', [], { size: 0 });
    await z.add('ü/é.txt', [Buffer.from('x')], { size: null });
  }, { forceZip64: true });
  // The first local header: version 4.5, a data descriptor follows (bit 3),
  // UTF-8 names (bit 11), and the ZIP64 extra holding the sizes' place.
  assert.equal(buf.readUInt32LE(0), 0x04034b50);
  assert.equal(buf.readUInt16LE(4), 45);
  assert.equal(buf.readUInt16LE(6), 0x0808);
  assert.equal(buf.readUInt32LE(18), 0xFFFFFFFF);
  assert.equal(buf.readUInt16LE(28), 20);
  assert.equal(buf.readUInt16LE(30 + 'a.flac'.length), 0x0001);
  // The ZIP64 end-of-central-directory record and its locator are present.
  assert.ok(buf.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])));
  assert.ok(buf.includes(Buffer.from([0x50, 0x4b, 0x06, 0x07])));
  const z = inspectZip(buf);
  assert.equal(z.bad, null);
  assert.deepEqual(z.names, ['a.flac', 'b.flac', 'ü/é.txt']);
  assert.deepEqual(z.sizes, [11, 0, 1]);
  assert.equal(Buffer.from(z.contents['a.flac'], 'base64').toString(), 'hello world');
});

test('zip writer: more than 65,535 entries switch the archive to ZIP64 and every entry is listed', async () => {
  const n = 65_537;
  const buf = await writeZip(async z => {
    for (let i = 0; i < n; i++) await z.add(`${i}`, [], { size: 0 });
  });
  const f = join(dir, 'many.zip');
  writeFileSync(f, buf);
  const count = execFileSync('python3', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); print(len(z.infolist()), z.testzip())', f]).toString().trim();
  assert.equal(count, `${n} None`);
});

test('zip writer: a source failing mid-entry rejects, so the caller can drop the connection', async () => {
  const z = new StoreZipWriter(async () => {});
  async function* failing() { yield Buffer.from('abc'); throw new Error('upstream died'); }
  await assert.rejects(z.add('x', failing(), { size: 10 }), /upstream died/);
});

test('zip writer: DOS times clamp to 1980 and keep the date', () => {
  assert.deepEqual(dosDateTime(new Date(1970, 0, 1)), { dosTime: 0, dosDate: 33 });
  const { dosDate, dosTime } = dosDateTime(new Date(2026, 2, 3, 10, 20, 31));
  assert.equal(dosDate, ((2026 - 1980) << 9) | (3 << 5) | 3);
  assert.equal(dosTime, (10 << 11) | (20 << 5) | 15);
});

// ── Names ────────────────────────────────────────────────────────────────────
test('names: safe on every desktop, extension from the file, then the server', () => {
  assert.equal(names.trackFileName({ id: 'x', artist: 'AC/DC', title: 'T.N.T.', fileSuffix: 'FLAC' }), 'AC-DC - T.N.T.flac');
  assert.equal(names.trackFileName({ id: 'x', artist: ' ', title: 'a\u0000b<c>|d*?' }), 'a b_c__d__');
  assert.equal(names.trackFileName({ id: 'x9', artist: null, title: '' }, { contentType: 'audio/mpeg' }), 'track x9.mp3');
  assert.equal(names.trackFileName({ id: 'x', artist: 'A', title: 'B' }, { disposition: `attachment; filename*=UTF-8''A%20B.m4a` }), 'A - B.m4a');
  assert.equal(names.trackFileName({ id: 'x', artist: 'A', title: 'B' }, { disposition: 'attachment; filename="weird.ext!"' }), 'A - B');
  assert.equal(names.safeSegment('CON'), '_CON');
  assert.equal(names.safeSegment('dots...  '), 'dots');
  assert.equal(Array.from(names.safeSegment('é'.repeat(300))).length, 120);
});

test('names: the zip is named for the station\'s day, not the UTC one', async () => {
  const { setStationTimezone } = await import('../src/time.js');
  // 23:30 UTC on the 24th: already the 25th in Paris, still the 24th in New York.
  const at = new Date('2026-11-24T23:30:00Z');
  try {
    setStationTimezone('Europe/Paris');
    assert.equal(names.zipFileName(3, at), 'library-3-tracks-2026-11-25.zip');
    setStationTimezone('America/New_York');
    assert.equal(names.zipFileName(3, at), 'library-3-tracks-2026-11-24.zip');
  } finally {
    setStationTimezone('');
  }
});

test('names: copies get (2), (3) whatever their case; the header carries the exact UTF-8 name', () => {
  const used = new Set<string>();
  assert.equal(names.uniqueName('A - B.flac', used), 'A - B.flac');
  assert.equal(names.uniqueName('a - b.FLAC', used), 'a - b (2).FLAC');
  assert.equal(names.uniqueName('A - B.flac', used), 'A - B (3).flac');
  assert.equal(names.attachmentDisposition('Björk - Jóga (Live).flac'),
    `attachment; filename="Bjork - Joga (Live).flac"; filename*=UTF-8''Bj%C3%B6rk%20-%20J%C3%B3ga%20%28Live%29.flac`);
});
