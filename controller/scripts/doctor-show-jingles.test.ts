// Doctor findings for per-show imaging allowlists (#1875, #1188): a list whose
// entries were all deleted skips that show's jingle slots or beds, and since
// #2367 the jingles count reads jingles.m3u as the on-air show's list. A bed list whose beds all exist but are too
// short for a threshold-length link airs links dry too (#2367).
//
// Run: `npm test -- doctor-show-jingles`.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempDir } from './test-utils/temp-dir.js';

const root = mkdtempSync(join(tmpdir(), 'subwave-doctor-show-jingles-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const { checkContent } = await import('../src/doctor/checks-content.js');
const jingles = await import('../src/broadcast/jingles.js');

mkdirSync(join(root, 'jingles'), { recursive: true });
mkdirSync(join(root, 'beds'), { recursive: true });
writeFileSync(join(root, 'jingles', 'jingle_a.wav'), 'audio');
writeFileSync(join(root, 'jingles.json'), JSON.stringify({ items: { 'jingle_a.wav': { text: 'A' } } }));
writeFileSync(join(root, 'beds', 'bed-x.mp3'), 'audio');
writeFileSync(join(root, 'beds', 'bed-short.mp3'), 'audio');
writeFileSync(join(root, 'beds.json'), JSON.stringify({ items: {
  'bed-x': { file: 'bed-x.mp3', durationSec: 60 },
  'bed-short': { file: 'bed-short.mp3', durationSec: 20 },
} }));

after(async () => { await removeTempDir(root); });

async function station(over: Record<string, unknown>, rotate: 'mixer' | 'controller', bedsOn = true, bedCfg: Record<string, unknown> = {}) {
  await settings.load();
  const lunch = { id: 's_lunch', name: 'The lunch show', personaId: settings.get().personas[0].id, ...over };
  const bedsPatch = { enabled: bedsOn, thresholdSec: 12, crossSec: 6, tailSec: 3, ...bedCfg };
  await settings.update({ shows: [lunch], jingleRotate: rotate, jinglePlacement: 'between', crossfadeDuration: 10, beds: bedsPatch } as never);
  return checkContent();
}
const labelled = (findings: any[], label: string) => findings.filter(f => f.label === label);

// Since #2367 the mixer's own rotate draws from the on-air show's list too, so
// the old "lists apply only when the controller counts" warning is gone.
test('doctor no longer warns that the mixer ignores show jingle lists', async () => {
  assert.deepEqual(labelled(await station({ allowedJingles: ['jingle_a.wav'] }, 'mixer'), 'show jingles'), []);
  assert.deepEqual(labelled(await station({ allowedJingles: ['jingle_a.wav'] }, 'controller'), 'show jingles'), []);
});

// jingles.m3u holds the on-air show's list, so its count is not the library's.
test('the jingles count names a show filter, and "generate the defaults" only for an empty library', async () => {
  await station({}, 'mixer');
  await jingles.applyShowList(undefined);
  const [all] = labelled(await checkContent(), 'jingles');
  assert.equal(all.status, 'ok');
  assert.equal(all.detail, '1 entries', 'no list: the file as before');
  await jingles.applyShowList(['gone.wav']);
  const [none] = labelled(await checkContent(), 'jingles');
  assert.equal(none.status, 'warn');
  assert.match(none.detail, /none of 1: the on-air show lists no jingle in the library/);
  assert.equal(none.fix, undefined, 'never "generate jingles" over a library that has them');
  assert.doesNotMatch(none.hint, /Generate the defaults/);
  await jingles.applyShowList(['jingle_a.wav']);
  const [listed] = labelled(await checkContent(), 'jingles');
  assert.equal(listed.status, 'ok');
  assert.equal(listed.detail, "1 of 1 (the on-air show's list)");
  await jingles.applyShowList(undefined);
});

test('doctor names a show whose jingle list matches nothing', async () => {
  const found = labelled(await station({ allowedJingles: ['gone.wav'] }, 'controller'), 'show lists');
  assert.equal(found.length, 1);
  assert.equal(found[0].status, 'warn');
  assert.match(found[0].detail, /"The lunch show": no listed jingle exists/);
  assert.match(found[0].detail, /automatic jingle slots are skipped/);
});

test('doctor names a show whose bed list matches nothing', async () => {
  const found = labelled(await station({ allowedBeds: ['gone'] }, 'controller'), 'show lists');
  assert.equal(found.length, 1);
  assert.match(found[0].detail, /"The lunch show": no listed bed exists/);
  assert.match(found[0].detail, /links air without a bed/);
  assert.deepEqual(labelled(await station({ allowedBeds: ['gone'] }, 'controller', false), 'show lists'), [], 'quiet while beds are off');
});

test('doctor is quiet when every list matches', async () => {
  const findings = await station({ allowedJingles: ['jingle_a.wav', 'gone.wav'], allowedBeds: ['bed-x'] }, 'controller');
  assert.deepEqual(labelled(findings, 'show lists'), []);
  assert.deepEqual(labelled(await station({}, 'controller'), 'show lists'), []);
});

// Defaults: a 12s link over a 10s crossfade needs 10 + 2.5 head + 12 + 3 tail +
// 6 ramp = 33.5s of bed (bed-policy.thresholdLinkBedSec).
test('doctor names a show whose listed beds are all too short for a link', async () => {
  const found = labelled(await station({ allowedBeds: ['bed-short'] }, 'controller'), 'show lists');
  assert.equal(found.length, 1);
  assert.equal(found[0].status, 'warn');
  assert.match(found[0].detail, /"The lunch show": no listed bed is 33\.5s or longer — a 12s link airs without a bed/);
  assert.match(found[0].hint, /library has longer beds this show doesn't list/);
  assert.deepEqual(labelled(await station({ allowedBeds: ['bed-short'] }, 'controller', false), 'show lists'), [], 'quiet while beds are off');
});

test('doctor is quiet when one listed bed is long enough', async () => {
  assert.deepEqual(labelled(await station({ allowedBeds: ['bed-short', 'bed-x'] }, 'controller'), 'show lists'), []);
  // An empty list means every bed, and the length check is the queue's to log.
  assert.deepEqual(labelled(await station({}, 'controller', true, { thresholdSec: 40 }), 'show lists'), []);
});

test('the short-bed hint says so when no bed in the library fits either', async () => {
  // 10 + 2.5 + 40 + 3 + 6 = 61.5s: past the 60s bed too.
  const [f] = labelled(await station({ allowedBeds: ['bed-x'] }, 'controller', true, { thresholdSec: 40 }), 'show lists');
  assert.match(f.detail, /no listed bed is 61\.5s or longer — a 40s link/);
  assert.match(f.hint, /No bed in the library is long enough either\. Upload one of 61\.5s or longer/);
});

test('the reference length follows the crossfade, as the queue sizes the bed', async () => {
  // A hard-cut station carries no entry cross: 0 + 2.5 + 12 + 3 + 6 = 23.5s, so
  // the 20s bed still misses; a 5s threshold (16.5s) lets it fit.
  await settings.load();
  const lunch = { id: 's_lunch', name: 'The lunch show', personaId: settings.get().personas[0].id, allowedBeds: ['bed-short'] };
  await settings.update({ shows: [lunch], crossfadeDuration: 0, beds: { enabled: true, thresholdSec: 12, crossSec: 6, tailSec: 3 } } as never);
  assert.match(labelled(await checkContent(), 'show lists')[0]?.detail ?? '', /23\.5s or longer/);
  await settings.update({ beds: { enabled: true, thresholdSec: 5, crossSec: 6, tailSec: 3 } } as never);
  assert.deepEqual(labelled(await checkContent(), 'show lists'), []);
});
