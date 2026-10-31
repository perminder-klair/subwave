// Orphan stem names (music/orphan-names.ts). The parse and the chain:
// sidecar → library/plays → recent-plays → event logs, with the log cache
// invalidated per test. The library db is deliberately CLOSED here — every
// source is optional, and these tests own the file-backed half of the chain;
// the plays/table half runs against a real db in the app's own test lanes.

import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const stateDir = createTempDir(join(tmpdir(), 'subwave-orphan-names-'));
const made: string[] = [stateDir];
after(async () => { for (const d of made) await removeTempDir(d); });
process.env.STATE_DIR = stateDir;
const names = await import('../src/music/orphan-names.js');

const ID_A = 'a'.repeat(22);
const ID_B = 'b'.repeat(22);
const ID_C = 'c'.repeat(22);
const ID_D = 'd'.repeat(22);

test('parseNameHits collects {id,title,artist} triples, honoring escapes and id shape', () => {
  const out = new Map();
  names.parseNameHits(
    `{"type":"navidrome","songIds":[{"id":"${ID_A}","title":"Shelf Wobbler","artist":"Mr. Scruff"},{"id":"short","title":"no","artist":"nope"}]}`,
    out,
  );
  assert.deepEqual(out.get(ID_A), { title: 'Shelf Wobbler', artist: 'Mr. Scruff', source: 'log' });
  assert.equal(out.size, 1, 'a non-22-char id is never claimed');
  // Escaped quotes survive JSON unescaping; a wanted-set filters the rest.
  const esc = new Map();
  names.parseNameHits(`{"x":[{"id":"${ID_B}","title":"Your Daddy\\"s Car","artist":"Divine Comedy"}]}`, esc);
  assert.equal(esc.get(ID_B)?.title, 'Your Daddy"s Car');
  const filtered = new Map();
  names.parseNameHits(`{"x":[{"id":"${ID_A}","title":"T","artist":"A"}]}`, filtered, new Set([ID_B]));
  assert.equal(filtered.size, 0);
});

function freshDirs() {
  const base = createTempDir(join(tmpdir(), 'subwave-orphan-dirs-'));
  made.push(base);
  const stems = join(base, 'stems');
  const logs = join(base, 'logs');
  mkdirSync(stems, { recursive: true });
  mkdirSync(logs, { recursive: true });
  names.invalidateLogNames();
  return { stateDir: base, stemsRootDir: stems, logDir: logs };
}

test('a sidecar answers first and survives without any other source', async () => {
  const dirs = freshDirs();
  const dir = join(dirs.stemsRootDir, ID_A);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, names.NAME_SIDECAR), JSON.stringify({ title: 'Marionette', artist: 'Mathew Jonson', album: 'Remixes' }));
  const got = await names.resolveOrphanNames([ID_A, ID_C], dirs);
  assert.equal(got.get(ID_A)?.title, 'Marionette');
  assert.equal(got.get(ID_A)?.source, 'sidecar');
  assert.equal(got.get(ID_C), undefined, 'unknown ids stay unknown, not empty-named');
});

test('the quarantine sidecar reads too (dot-dir walk still sees it)', async () => {
  const dirs = freshDirs();
  const qu = join(dirs.stemsRootDir, '.orphan-quarantine', ID_B);
  mkdirSync(qu, { recursive: true });
  writeFileSync(join(qu, names.NAME_SIDECAR), JSON.stringify({ title: 'Hiraeth', artist: 'Sid Le Rock' }));
  const got = await names.resolveOrphanNames([ID_B], dirs);
  assert.equal(got.get(ID_B)?.title, 'Hiraeth');
  assert.equal(got.get(ID_B)?.artist, 'Sid Le Rock');
});

test('recent-plays.json fills what no sidecar covers', async () => {
  const dirs = freshDirs();
  writeFileSync(join(dirs.stateDir, 'recent-plays.json'), JSON.stringify([
    { id: ID_A, title: 'Mechanic Doll', artist: 'Odagled', album: 'Importante EP', endedAt: 'x' },
    { id: ID_B, title: 'Second', artist: 'Two', album: 'B', endedAt: 'y' },
  ]));
  const got = await names.resolveOrphanNames([ID_A, ID_B, ID_C], dirs);
  assert.equal(got.get(ID_A)?.album, 'Importante EP');
  assert.equal(got.get(ID_A)?.source, 'recent');
  assert.equal(got.get(ID_C), undefined);
});

test('event logs answer last, and only for what the cheap sources missed', async () => {
  const dirs = freshDirs();
  // Two rolling files, the second holding the only hit for ID_C.
  writeFileSync(join(dirs.logDir, 'events-2026-10-01.jsonl'),
    `{"type":"navidrome","songIds":[{"id":"${ID_A}","title":"From Logs","artist":"Logger"}]}\n`);
  writeFileSync(join(dirs.logDir, 'events-2026-10-02.jsonl'),
    `{"type":"other"}\n{"type":"navidrome","songIds":[{"id":"${ID_C}","title":"Late Hit","artist":"Tail"}]}\n`);
  const got = await names.resolveOrphanNames([ID_A, ID_C, ID_D], dirs);
  assert.equal(got.get(ID_A)?.source, 'log');
  assert.equal(got.get(ID_C)?.title, 'Late Hit');
  assert.equal(got.get(ID_D), undefined);
  // A second call is served by the cache (delete the files, still resolves).
  const { rmSync } = await import('node:fs');
  rmSync(join(dirs.logDir, 'events-2026-10-01.jsonl'));
  rmSync(join(dirs.logDir, 'events-2026-10-02.jsonl'));
  const again = await names.resolveOrphanNames([ID_A], dirs);
  assert.equal(again.get(ID_A)?.title, 'From Logs');
});

test('skipLogs keeps a cheap resolver cheap', async () => {
  const dirs = freshDirs();
  writeFileSync(join(dirs.logDir, 'events-2026-10-01.jsonl'),
    `{"type":"navidrome","songIds":[{"id":"${ID_A}","title":"Should Not Be Read","artist":"Nope"}]}\n`);
  const got = await names.resolveOrphanNames([ID_A], { ...dirs, skipLogs: true });
  assert.equal(got.get(ID_A), undefined);
});

test('a confirmed quarantine stamps the resolved name before the logs can age it', async () => {
  // The IO half: runOrphanPurge with an injected resolver writes .track-meta.json
  // into the quarantine for exactly the ids it moved. Same cached stem-cache
  // root as the rest of this file (the module resolves it at import).
  const cache = await import('../src/music/stem-cache.js');
  const purge = await import('../src/music/orphan-purge.js');
  const root = cache.stemsRoot();
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, cache.STEMS_MARKER), '{}');
  const id = ID_A;
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'window-drums.flac'), 'x');
  const { utimesSync } = await import('node:fs');
  const t = new Date(Date.now() - 2 * 86400_000);
  utimesSync(dir, t, t);
  const rep = await purge.runOrphanPurge({
    knownIds: ['_sentinel'],
    confirm: true,
    resolveNames: async () => new Map([[id, { title: 'Stamped Title', artist: 'Stamper', source: 'log' as const }]]),
  });
  assert.equal(rep.quarantined, 1);
  const sidecar = join(root, '.orphan-quarantine', id, names.NAME_SIDECAR);
  assert.ok(existsSync(sidecar), 'the quarantine carries the name forward');
  const stamped = JSON.parse(readFileSync(sidecar, 'utf8')) as Record<string, unknown>;
  assert.equal(stamped.title, 'Stamped Title');
  assert.equal(stamped.artist, 'Stamper');
  assert.equal(typeof stamped.orphanedAt, 'number');
});

test('the orphan list keeps the purge\'s in-flight grace: a dir written within the hour is not listed', async () => {
  // The panel's "Show tracks" list and the report count the same folders.
  const cache = await import('../src/music/stem-cache.js');
  const root = cache.stemsRoot();
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, cache.STEMS_MARKER), '{}');
  const old = join(root, ID_C);
  const fresh = join(root, ID_D);
  mkdirSync(old, { recursive: true });
  mkdirSync(fresh, { recursive: true });
  const t = new Date(Date.now() - 2 * 3600_000);
  utimesSync(old, t, t);
  assert.deepEqual(await names.listOrphanDirNames(new Set()), [ID_C]);
});
