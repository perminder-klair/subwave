// The replaced-file end of the library walk (tag-library/flags.ts,
// walkNavidrome) through the real CLI against a fake Navidrome: a few candidates
// clear and move the mark; a mass of them is held with the sizes and the mark
// left alone, and Reconcile says so rather than "in sync"; --confirm-replaced
// clears a held mass; --accept-replaced clears nothing and the same files are
// not found again, those within the mark's margin included; a single-facet
// write or a failed attempt does not hide a held candidate; a partial read is
// acted on without moving the mark. The policy and the DB writes on their own
// are in replaced-file.test.ts and file-changes.test.ts.
//
// Run: npm test -- replaced-file-walk

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const state = createTempDir(join(tmpdir(), 'subwave-replaced-walk-'));
const controller = fileURLToPath(new URL('../', import.meta.url));

const HOUR = 3_600_000;
const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const FILE_DATE = '2026-01-01T00:00:00.000Z';
const MEASURED = '2026-06-01T00:00:00.000Z';
// A previous walk's mark, and a change time past it.
const MARK = iso(NOW - 2 * HOUR);
const CHANGED = iso(NOW - HOUR / 2);

// The mass hold starts above 200 on a library this size.
const TRACKS = 240;
const MASS = 210;
const SIZE = 100_000;

interface Song { id: string; size: number; updatedAt: string }
let songs: Song[] = [];
// Native rows that are not in the walk: they fill a page without being tracks.
let padding: Song[] = [];
let failDeepPage = false;
let refuseLogin = false;
const by = (id: string) => songs.find(s => s.id === id) as Song;
// The events a run flagged as a hold, for the panel to keep once it stops.
const holdsIn = (out: string) => out.split('\n')
  .filter(line => line.startsWith('[event] '))
  .map(line => JSON.parse(line.slice('[event] '.length)) as { kind: string; text: string; hold?: boolean })
  .filter(event => event.hold);

function subsonic(req: IncomingMessage, res: ServerResponse, url: URL) {
  const endpoint = (url.pathname.split('/').at(-1) ?? '').replace(/\.view$/, '');
  const sub: Record<string, unknown> = { status: 'ok', version: '1.16.1', type: 'navidrome', serverVersion: '0.58.0', openSubsonic: true };
  switch (endpoint) {
    case 'ping': break;
    case 'getScanStatus': sub.scanStatus = { scanning: false }; break;
    case 'getAlbumList2': sub.albumList2 = { album: [{ id: 'a', name: 'Album', artist: 'Artist' }] }; break;
    case 'getAlbum':
      sub.album = {
        id: 'a',
        name: 'Album',
        artist: 'Artist',
        year: 2001,
        song: songs.map(s => ({
          id: s.id, title: s.id, artist: 'Artist', album: 'Album', year: 2001, duration: 200,
          path: `/music/${s.id}.flac`, suffix: 'flac', size: s.size, bitRate: 900,
        })),
      };
      break;
    default:
      res.statusCode = 404;
      res.end('{}');
      return;
  }
  res.end(JSON.stringify({ 'subsonic-response': sub }));
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  res.setHeader('content-type', 'application/json');
  if (url.pathname === '/auth/login') {
    if (refuseLogin) res.statusCode = 401;
    res.end(JSON.stringify(refuseLogin ? { error: 'no' } : { token: 'tok' }));
    return;
  }
  if (url.pathname === '/api/song') {
    const start = Number(url.searchParams.get('_start'));
    if (failDeepPage && start > 0) {
      res.statusCode = 500;
      res.end('{"error":"ambiguous column name: updated_at"}');
      return;
    }
    const newestFirst = [...songs, ...padding].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    res.end(JSON.stringify(newestFirst.slice(start, Number(url.searchParams.get('_end')))));
    return;
  }
  subsonic(req, res, url);
});
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.STATE_DIR = state;
process.env.NAVIDROME_URL = origin;
process.env.NAVIDROME_USER = 'fixture';
process.env.NAVIDROME_PASS = 'fixture';

const preload = join(state, 'network.mjs');
writeFileSync(preload, `
const request = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(String(input));
  if (url.origin !== ${JSON.stringify(origin)}) return Promise.reject(new Error('external network disabled'));
  return request(input, init);
};
`);

const db = await import('../src/music/library-db.js');
const stems = await import('../src/music/stem-cache.js');
await db.open({ embeddingDim: 8, adoptStoredDim: true });

const markFile = join(state, 'navidrome-file-changes.json');
const mark = (): string | null => (existsSync(markFile) ? JSON.parse(readFileSync(markFile, 'utf8')).newest : null);
const stored = (id: string) =>
  db.requireDb().prepare('SELECT bpm, file_size FROM tracks WHERE id = ?').get(id) as { bpm: number | null; file_size: number };

test.beforeEach(() => {
  db.pruneMissingTracks(new Set());
  songs = Array.from({ length: TRACKS }, (_, i) => ({ id: `s${i}`, size: SIZE + i, updatedAt: FILE_DATE }));
  padding = [];
  failDeepPage = false;
  refuseLogin = false;
  for (const s of songs) {
    db.upsertTrackMeta(s.id, { title: s.id, artist: 'Artist', duration: 200, fileSize: s.size });
    db.upsertTrackAnalysis(s.id, { bpm: 100, musicalKey: 'C', loudnessLufs: -9, peakDb: -1, source: 'full' });
  }
  db.requireDb().prepare('UPDATE track_facet_status SET at = ?').run(MEASURED);
  writeFileSync(markFile, JSON.stringify({ newest: MARK }));
});

test.after(async () => {
  db.close();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await removeTempDir(state);
});

// A real reconcile: the walk, then its final progress label and the walk's one
// line on the change-time signal.
async function reconcile(...flags: string[]): Promise<{ out: string; check: string; label: string }> {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--import', preload, 'src/music/tag-library.ts', '--reconcile-only', ...flags],
    { cwd: controller, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 },
  );
  let out = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { out += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(code, 0, out);
  return {
    out,
    check: out.match(/Replaced-file check[^"\n]*/)?.[0] ?? '',
    label: [...out.matchAll(/"label":"([^"]*)"/g)].at(-1)?.[1] ?? '',
  };
}

function massChange() {
  for (let i = 0; i < MASS; i++) by(`s${i}`).updatedAt = CHANGED;
  by(`s${MASS}`).size += 5;
}

test('a few replaced files clear at the end of the walk, lose their stems and move the mark', async () => {
  const root = stems.stemsRoot();
  mkdirSync(join(root, 's0'), { recursive: true });
  writeFileSync(join(root, 's0', 'head-drums.flac'), 'x');
  writeFileSync(join(root, stems.STEMS_MARKER), '');
  by('s0').size += 5;
  by('s1').updatedAt = CHANGED;

  const { check } = await reconcile();

  assert.match(check, /1 by size, 1 by change time/);
  assert.equal(stored('s0').bpm, null, 'a changed size clears');
  assert.equal(stored('s0').file_size, by('s0').size, 'the new size lands with the clear');
  assert.equal(stored('s1').bpm, null, 'a newer change time clears a file of the same size');
  assert.equal(stored('s2').bpm, 100);
  assert.equal(existsSync(join(root, 's0')), false, 'the stems go');
  assert.equal(mark(), CHANGED);
});

test('a mass replacement is held: nothing clears, the sizes and the mark stay, and Reconcile says so', async () => {
  massChange();

  const first = await reconcile();

  assert.match(first.out, /NOT cleared/);
  assert.match(first.out, /--accept-replaced/);
  assert.match(first.out, /--confirm-replaced/);
  assert.doesNotMatch(first.label, /in sync/i, 'a hold is not "in sync"');
  assert.match(first.label, new RegExp(`${MASS + 1} replaced files on hold`));
  const holds = holdsIn(first.out);
  assert.equal(holds.length, 1, 'the panel is told, not just the log');
  assert.equal(holds[0].kind, 'warning');
  assert.match(holds[0].text, /--accept-replaced/);
  assert.equal(stored('s0').bpm, 100);
  assert.equal(stored(`s${MASS}`).file_size, SIZE + MASS, 'a held size is not stored');
  assert.equal(mark(), MARK, 'a held clear does not move the mark');

  const next = await reconcile();
  assert.match(next.check, new RegExp(`1 by size, ${MASS} by change time`), 'the next walk finds them again');
  assert.equal(mark(), MARK);
});

test('a held mass removal reaches the panel the same way', async () => {
  songs = songs.slice(0, TRACKS - MASS);

  const { out, label } = await reconcile();

  assert.match(label, /Removal of missing tracks on hold/);
  const holds = holdsIn(out);
  assert.equal(holds.length, 1);
  assert.match(holds[0].text, /Removal is on hold/);
  assert.equal(db.requireDb().prepare('SELECT COUNT(*) AS n FROM tracks').get().n, TRACKS, 'nothing was removed');
});

test('--confirm-replaced clears a held mass and moves the mark', async () => {
  massChange();

  const { out, label } = await reconcile('--confirm-replaced');

  assert.doesNotMatch(out, /NOT cleared/);
  assert.doesNotMatch(label, /on hold/);
  assert.equal(stored('s0').bpm, null);
  assert.equal(stored(`s${MASS}`).bpm, null);
  assert.equal(stored(`s${MASS}`).file_size, SIZE + MASS + 5);
  assert.equal(mark(), CHANGED);
});

test('--accept-replaced clears nothing, and the same files are not found again', async () => {
  massChange();
  const stemDir = join(stems.stemsRoot(), 's0');
  mkdirSync(stemDir, { recursive: true });

  const accepted = await reconcile('--accept-replaced');

  assert.doesNotMatch(accepted.out, /NOT cleared/);
  assert.deepEqual(holdsIn(accepted.out), []);
  assert.match(accepted.out, new RegExp(`${MASS + 1} file\\(s\\) accepted`));
  assert.equal(stored('s0').bpm, 100, 'the analysis stays');
  assert.equal(existsSync(stemDir), true, 'the stems stay');
  assert.equal(stored(`s${MASS}`).file_size, SIZE + MASS + 5, 'the size is stored');
  assert.equal(mark(), CHANGED, 'the mark moves');

  // The next floor is the mark less its margin, so these same files are read
  // again. Moving the mark alone would find every one of them.
  const next = await reconcile();
  assert.match(next.check, new RegExp(`${MASS} change\\(s\\) read`));
  assert.match(next.check, /0 by size, 0 by change time/);
  assert.match(next.label, /in sync/i);

  // Accepting is about those files as they were: a later replacement still
  // counts. Dated ahead, inside the margin, because the accept was moments ago.
  by('s0').updatedAt = iso(Date.now() + 60_000);
  await reconcile();
  assert.equal(stored('s0').bpm, null);
});

test('an accepted file dated inside the margin is not found again', async () => {
  // Past now, not past the margin: a change to the walk, and newer than a stamp of now.
  by('s0').updatedAt = iso(Date.now() + 3 * HOUR);

  const accepted = await reconcile('--accept-replaced');

  assert.match(accepted.check, /0 by size, 1 by change time/);
  assert.equal(stored('s0').bpm, 100);

  const next = await reconcile();
  assert.match(next.check, /1 change\(s\) read/, 'the same file is read again');
  assert.match(next.check, /0 by size, 0 by change time/);
  assert.equal(stored('s0').bpm, 100, 'the analysis stays');
});

test('an accepted mass dated inside the margin does not go back on hold', async () => {
  for (let i = 0; i < MASS; i++) by(`s${i}`).updatedAt = iso(Date.now() + 3 * HOUR);

  await reconcile('--accept-replaced');

  const next = await reconcile();
  assert.match(next.check, /0 by size, 0 by change time/);
  assert.match(next.label, /in sync/i);
  assert.equal(stored('s0').bpm, 100);
});

test('accept wins over confirm: given both, nothing is lost', async () => {
  by('s0').updatedAt = CHANGED;
  await reconcile('--confirm-replaced', '--accept-replaced');
  assert.equal(stored('s0').bpm, 100);
});

test('a single-facet write or a failed attempt does not hide a held candidate', async () => {
  massChange();
  await reconcile();
  // What each leaves behind: the CLAP-only fast path, a facet plan, a failed try.
  db.upsertTrackAudioVector('s0', new Float32Array(db.AUDIO_EMBEDDING_DIM).fill(0.1));
  db.writeFacetResults('s1', { source: 'url', stems: { attempted: true } });
  db.recordAnalysisFailure('s2', 'decoder error');

  await reconcile('--confirm-replaced');

  for (const id of ['s0', 's1', 's2']) assert.equal(stored(id).bpm, null, `${id} is still found`);
});

test('a single-facet write does not hide a replacement with no hold either', async () => {
  by('s0').updatedAt = CHANGED;
  db.upsertTrackAudioVector('s0', new Float32Array(db.AUDIO_EMBEDDING_DIM).fill(0.1));

  await reconcile();

  assert.equal(stored('s0').bpm, null);
});

test('a partial read is acted on, says so, and does not move the mark', async () => {
  by('s0').updatedAt = CHANGED;
  padding = Array.from({ length: 1_000 }, (_, i) => ({ id: `pad${i}`, size: 1, updatedAt: iso(NOW - HOUR) }));
  failDeepPage = true;

  const { check } = await reconcile();

  assert.match(check, /partial/);
  assert.doesNotMatch(check, /server stopped/, 'running out of pages is not the server\'s doing');
  assert.equal(stored('s0').bpm, null, 'the changes read are the newest: they still count');
  assert.equal(mark(), MARK);
});

test('a refused login reads as size only, without blaming the server for having no change times', async () => {
  by('s0').size += 5;
  by('s1').updatedAt = CHANGED;
  refuseLogin = true;

  const { check } = await reconcile();

  assert.match(check, /size only/);
  assert.match(check, /refused/);
  assert.match(check, /kept the password back/);
  assert.equal(stored('s0').bpm, null, 'the size check stands alone');
  assert.equal(stored('s1').bpm, 100);
  assert.equal(mark(), MARK);
});
