// Doctor warns when the running mixer is older than the jingle playlist swap
// (#2367): such a mixer reloads jingles.m3u in place, so a show's jingle list
// starts one stinger late and nothing else says so. radio.liq answers
// `jingle_list_swap` whatever the rotate, so only an older mixer's "unknown
// command" warns; an unreachable mixer or any other reply says nothing.
//
// Run: `npm test -- doctor-jingle-swap`.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const root = createTempDir(join(tmpdir(), 'subwave-doctor-jingle-swap-'));
process.env.STATE_DIR = root;

const UNKNOWN = 'ERROR: unknown command, type "help" to get a list of commands.\r\nEND\r\n';
// A stand-in mixer: the probe gets `probe`, every other command an OK.
let probe: 'yes' | 'older' | 'drop' | 'odd' = 'yes';
const commands: string[] = [];
const mixer = createServer(socket => socket.once('data', data => {
  const cmd = data.toString().split('\n')[0].trim();
  commands.push(cmd);
  if (cmd !== 'jingle_list_swap') return void socket.end('OK\r\nEND\r\n');
  if (probe === 'drop') socket.destroy();
  else socket.end(probe === 'yes' ? 'yes\r\nEND\r\n' : probe === 'older' ? UNKNOWN : 'maybe\r\nEND\r\n');
}));
await new Promise<void>(resolve => mixer.listen(0, '127.0.0.1', resolve));
process.env.LIQUIDSOAP_HOST = '127.0.0.1';
process.env.LIQUIDSOAP_PORT = String((mixer.address() as { port: number }).port);

const settings = await import('../src/settings.js');
const { checkContent } = await import('../src/doctor/checks-content.js');
const { jingleListSwap } = await import('../src/broadcast/liquidsoap-control.js');

mkdirSync(join(root, 'jingles'), { recursive: true });
writeFileSync(join(root, 'jingles', 'jingle_a.wav'), 'audio');
writeFileSync(join(root, 'jingles.json'), JSON.stringify({ items: { 'jingle_a.wav': { text: 'A' } } }));

after(async () => {
  await new Promise(resolve => mixer.close(resolve));
  await removeTempDir(root);
});

async function findings(mixerSays: typeof probe, show: Record<string, unknown>, over: Record<string, unknown> = {}) {
  probe = mixerSays;
  await settings.load();
  const lunch = { id: 's_lunch', name: 'The lunch show', personaId: settings.get().personas[0].id, ...show };
  await settings.update({ shows: [lunch], jingleRotate: 'mixer', jinglePlacement: 'between', ...over } as never);
  commands.length = 0;
  return (await checkContent()).filter(f => f.label === 'mixer jingles');
}
const LISTED = { allowedJingles: ['jingle_a.wav'] };

test('the probe reads yes, an older mixer and everything else apart', async () => {
  probe = 'yes';
  assert.equal(await jingleListSwap(), 'yes');
  probe = 'older';
  assert.equal(await jingleListSwap(), 'no');
  probe = 'odd';
  assert.equal(await jingleListSwap(), 'unknown');
  probe = 'drop';
  assert.equal(await jingleListSwap(), 'unknown', 'a dropped connection is not an older mixer');
});

test('an older mixer warns when the mixer counts the rotate and a show lists jingles', async () => {
  const found = await findings('older', LISTED);
  assert.equal(found.length, 1);
  assert.equal(found[0].status, 'warn');
  assert.match(found[0].detail ?? '', /1 show\(s\) list jingles/);
  assert.match(found[0].detail ?? '', /one stinger late/);
  assert.match(found[0].hint ?? '', /broadcast container/);
});

test('a current mixer, a dropped probe and an odd reply all stay quiet', async () => {
  assert.deepEqual(await findings('yes', LISTED), []);
  assert.deepEqual(await findings('drop', LISTED), []);
  assert.deepEqual(await findings('odd', LISTED), []);
});

test('the mixer is not asked when no show lists jingles or the controller counts the rotate', async () => {
  assert.deepEqual(await findings('older', {}), []);
  assert.ok(!commands.includes('jingle_list_swap'), 'no list: no probe');
  assert.deepEqual(await findings('older', LISTED, { jingleRotate: 'controller' }), []);
  assert.ok(!commands.includes('jingle_list_swap'), 'controller rotate: no probe');
  assert.deepEqual(await findings('older', LISTED, { jinglePlacement: 'over' }), []);
  assert.ok(!commands.includes('jingle_list_swap'), 'over-music placement: the controller draws');
});

// "unknown command" must mean an older mixer, never a mixer without a rotate,
// so the command sits at the top level, outside `if jingle_ratio() > 0`.
test('radio.liq registers jingle_list_swap at the top level', () => {
  const liq = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../liquidsoap/radio.liq'), 'utf8');
  assert.match(liq, /^server\.register\(\n {2}"jingle_list_swap",[\s\S]*?\n {2}fun\(_\) -> "yes"\n\)/m);
});
