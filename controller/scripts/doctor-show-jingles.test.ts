// Doctor findings for per-show imaging allowlists (#1875, #1188): the mixer's
// rotate ignores jingle lists, and a list whose entries were all deleted skips
// that show's jingle slots or beds.
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

mkdirSync(join(root, 'jingles'), { recursive: true });
mkdirSync(join(root, 'beds'), { recursive: true });
writeFileSync(join(root, 'jingles', 'jingle_a.wav'), 'audio');
writeFileSync(join(root, 'jingles.json'), JSON.stringify({ items: { 'jingle_a.wav': { text: 'A' } } }));
writeFileSync(join(root, 'beds', 'bed-x.mp3'), 'audio');
writeFileSync(join(root, 'beds.json'), JSON.stringify({ items: { 'bed-x': { file: 'bed-x.mp3', durationSec: 60 } } }));

after(async () => { await removeTempDir(root); });

async function station(over: Record<string, unknown>, rotate: 'mixer' | 'controller', bedsOn = true) {
  await settings.load();
  const lunch = { id: 's_lunch', name: 'The lunch show', personaId: settings.get().personas[0].id, ...over };
  await settings.update({ shows: [lunch], jingleRotate: rotate, jinglePlacement: 'between', beds: { enabled: bedsOn } } as never);
  return checkContent();
}
const labelled = (findings: any[], label: string) => findings.filter(f => f.label === label);

test('doctor warns when the mixer counts and a show lists jingles', async () => {
  const [f, ...rest] = labelled(await station({ allowedJingles: ['jingle_a.wav'] }, 'mixer'), 'show jingles');
  assert.equal(rest.length, 0);
  assert.equal(f?.status, 'warn');
  assert.match(f.hint, /only when the controller counts/);
  assert.match(f.hint, /counted by: Controller/);
});

test('doctor is quiet when the controller counts', async () => {
  assert.deepEqual(labelled(await station({ allowedJingles: ['jingle_a.wav'] }, 'controller'), 'show jingles'), []);
  assert.deepEqual(labelled(await station({}, 'mixer'), 'show jingles'), []);
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
