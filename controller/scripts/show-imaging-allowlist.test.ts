// Per-show jingle and bed allowlists (#1875, #1188): the two show fields, and
// how the automatic draws honour them. An empty list allows everything.
//
// Run: `npm test -- show-imaging-allowlist`.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listen } from './test-utils/http.js';
import { removeTempDir } from './test-utils/temp-dir.js';

const root = mkdtempSync(join(tmpdir(), 'subwave-show-imaging-allowlist-'));
process.env.STATE_DIR = root;
delete process.env.ADMIN_USER;
delete process.env.ADMIN_PASS;

const express = (await import('express')).default;
const settings = await import('../src/settings.js');
const { setCache } = await import('../src/settings/store.js');
const { router: publicRouter } = await import('../src/routes/public.js');
const { allowedForShow } = await import('../src/broadcast/show-allowlist.js');
const { queue } = await import('../src/broadcast/queue.js') as any;

// Three jingles on disk, so jingles.list() (which keeps only existing files)
// returns all three.
const jingleDir = join(root, 'jingles');
mkdirSync(jingleDir, { recursive: true });
for (const f of ['jingle_a.wav', 'jingle_b.wav', 'jingle_c.wav']) writeFileSync(join(jingleDir, f), 'audio');
writeFileSync(join(root, 'jingles.json'), JSON.stringify({ items: {
  'jingle_a.wav': { text: 'A' }, 'jingle_b.wav': { text: 'B' }, 'jingle_c.wav': { text: 'C' },
} }));

const real = {
  playJingle: queue.playJingle, log: queue.log,
  bedCatalog: queue._bedCatalog, bedGetPath: queue._bedGetPath, writeHandoff: queue._writeHandoff,
};
after(async () => {
  Object.assign(queue, {
    playJingle: real.playJingle, log: real.log,
    _bedCatalog: real.bedCatalog, _bedGetPath: real.bedGetPath, _writeHandoff: real.writeHandoff,
  });
  const db = await import('../src/music/library-db.js'); db.close();
  await removeTempDir(root);
});

// Records what reaches the mixer and the booth log instead of airing it.
function capture() {
  const played: string[] = [];
  const logs: string[] = [];
  queue.playJingle = async (filename: string) => { played.push(filename); return { ok: true }; };
  queue.log = (_kind: string, message: string) => { logs.push(message); };
  return { played, logs };
}

const LUNCH = 's_lunch';
async function lunchOnAir(over: Record<string, unknown> = {}) {
  await settings.load();
  const at = Date.now();
  const show = { id: LUNCH, name: 'The lunch show', personaId: settings.get().personas[0].id, ...over };
  await settings.update({
    shows: [show],
    scheduleOverride: { showId: LUNCH, startedAt: at - 60_000, expiresAt: at + 3600_000 },
  } as never);
}

test('allowlists survive settings cold load', async () => {
  await lunchOnAir({ allowedJingles: ['jingle_a.wav'], allowedBeds: ['bed-x'] });
  setCache(null);
  await settings.load();
  const show = settings.resolveActiveShow() as any;
  assert.equal(show?.id, LUNCH);
  assert.deepEqual(show.allowedJingles, ['jingle_a.wav']);
  assert.deepEqual(show.allowedBeds, ['bed-x']);
});

test('public schedule omits allowlists', async () => {
  await lunchOnAir({ allowedJingles: ['jingle_a.wav'], allowedBeds: ['bed-x'] });
  const app = express();
  app.use(publicRouter);
  const { server, url } = await listen(app);
  try {
    const body = await (await fetch(`${url}/schedule`)).json() as any;
    const entry = body.shows.find((s: any) => s.id === LUNCH);
    assert.ok(entry, 'the lunch show is listed');
    assert.equal('allowedJingles' in entry, false);
    assert.equal('allowedBeds' in entry, false);
  } finally {
    server.close();
  }
});

const THREE = ['jingle_a.wav', 'jingle_b.wav', 'jingle_c.wav'];
const id = (s: string) => s;

test('allowedForShow returns every item for an empty list', () => {
  assert.deepEqual(allowedForShow(THREE, [], id), THREE);
});

test('allowedForShow returns every item when no show is on air', () => {
  assert.deepEqual(allowedForShow(THREE, undefined, id), THREE);
});

test('allowedForShow keeps only listed items and matches nothing for stale names', () => {
  assert.deepEqual(allowedForShow(THREE, ['jingle_c.wav', 'gone.wav'], id), ['jingle_c.wav']);
  assert.deepEqual(allowedForShow(THREE, ['gone.wav'], id), []);
});

test('rotate draws only listed jingles', async () => {
  await lunchOnAir({ allowedJingles: ['jingle_a.wav'] });
  const { played } = capture();
  for (let i = 0; i < 12; i++) assert.equal(await queue.playRotateJingle(), true);
  assert.deepEqual([...new Set(played)], ['jingle_a.wav']);
});

test('rotate skips when no listed jingle exists', async () => {
  await lunchOnAir({ allowedJingles: ['gone.wav'] });
  const { played, logs } = capture();
  queue._tracksSinceJingle = 5;
  assert.equal(await queue.playRotateJingle(), false);
  assert.equal(queue._tracksSinceJingle, 0, 'the offer is spent');
  assert.deepEqual(played, []);
  assert.ok(logs.some(l => l.includes('rotate skipped') && l.includes('The lunch show') && l.includes('allows none')), logs.join('\n'));
});

// A long link with nothing to trample, and no host-speech stamp to go stale.
function linkItem() {
  return {
    track: { id: 'bed-song', title: 'Bed Song', artist: 'Artist', duration: 240 },
    requestedBy: null,
    introKind: 'link',
    introScript: 'A deliberately long spoken link across enough words to need an instrumental bed before this incoming song begins for listeners tonight.',
    introWav: '/tmp/allowlist-link.wav',
    introAired: false,
    introHostSpeech: null,
    linkPrev: null,
    sent: false,
  } as any;
}

async function bedFor(allowedBeds: string[], catalog: { name: string; durationSec: number }[]) {
  await lunchOnAir({ allowedBeds });
  await settings.update({ beds: { enabled: true, thresholdSec: 1 } } as never);
  const { logs } = capture();
  const pushed: string[] = [];
  queue._bedCatalog = async () => catalog;
  queue._bedGetPath = async (name: string) => { pushed.push(name); return `/tmp/${name}.mp3`; };
  queue._writeHandoff = async () => {};
  queue._lastBed = null;
  const item = linkItem();
  queue.upcoming = [item];
  queue.current = null;
  await queue.maybePushBed(item);
  return { pushed, logs, item };
}

test('bed choice uses every bed for an empty list', async () => {
  const seen = new Set<string>();
  for (let i = 0; i < 40 && seen.size < 2; i++) {
    const { pushed } = await bedFor([], [{ name: 'bed-x', durationSec: 300 }, { name: 'bed-y', durationSec: 300 }]);
    pushed.forEach(n => seen.add(n));
  }
  assert.deepEqual([...seen].sort(), ['bed-x', 'bed-y']);
});

test('bed choice uses only listed beds', async () => {
  for (let i = 0; i < 12; i++) {
    const { pushed } = await bedFor(['bed-x'], [{ name: 'bed-x', durationSec: 300 }, { name: 'bed-y', durationSec: 300 }]);
    assert.deepEqual(pushed, ['bed-x']);
  }
});

test('listed bed missing or short means no bed', async () => {
  for (const listed of [['gone'], ['bed-short']]) {
    const { pushed, logs, item } = await bedFor(listed, [{ name: 'bed-short', durationSec: 1 }, { name: 'bed-y', durationSec: 300 }]);
    assert.deepEqual(pushed, [], `no bed for ${listed}`);
    assert.notEqual(item.bedded, true);
    assert.ok(logs.some(l => l.includes('The lunch show') && l.includes('allows no bed')), logs.join('\n'));
  }
});

test('allowlist over the cap is refused on save and the stored show is unchanged', async () => {
  await lunchOnAir({ allowedJingles: ['jingle_a.wav'] });
  const { SHOW_IMAGING_ALLOWLIST_MAX } = await import('../src/schemas/show.js');
  const many = Array.from({ length: SHOW_IMAGING_ALLOWLIST_MAX + 1 }, (_, i) => `jingle_${i}.wav`);
  const lunch = settings.get().shows.find((s: any) => s.id === LUNCH);
  await assert.rejects(settings.update({ shows: [{ ...lunch, allowedJingles: many }] } as never), /allowedJingles/);
  const stored = settings.get().shows.find((s: any) => s.id === LUNCH) as any;
  assert.deepEqual(stored.allowedJingles, ['jingle_a.wav']);
});

// Last in the file: it leaves a live session behind.
test('a look-ahead session uses the incoming show list before the grid flips', async () => {
  const session = await import('../src/broadcast/session.js');
  const late = { id: 's_late', name: 'The late show', personaId: settings.get().personas[0].id, allowedJingles: ['jingle_b.wav'], allowedBeds: ['bed-y'] };
  await lunchOnAir({ allowedJingles: ['jingle_a.wav'], allowedBeds: ['bed-x'] });
  await settings.update({ shows: [...settings.get().shows, late] } as never);
  session.start({ at: new Date().toISOString(), time: { period: 'night' }, activeShow: { id: late.id, name: late.name } } as any);

  const { played } = capture();
  for (let i = 0; i < 6; i++) await queue.playRotateJingle();
  assert.deepEqual([...new Set(played)], ['jingle_b.wav']);

  await settings.update({ beds: { enabled: true, thresholdSec: 1 } } as never);
  const pushed: string[] = [];
  queue._bedCatalog = async () => [{ name: 'bed-x', durationSec: 300 }, { name: 'bed-y', durationSec: 300 }];
  queue._bedGetPath = async (name: string) => { pushed.push(name); return `/tmp/${name}.mp3`; };
  queue._writeHandoff = async () => {};
  for (let i = 0; i < 6; i++) {
    queue._lastBed = null;
    const item = linkItem();
    queue.upcoming = [item];
    queue.current = null;
    await queue.maybePushBed(item);
  }
  assert.deepEqual([...new Set(pushed)], ['bed-y']);
});
