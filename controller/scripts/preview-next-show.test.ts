import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-preview-next-show-'));
process.env.STATE_DIR = root;
const settings = await import('../src/settings.js');
const { setCache } = await import('../src/settings/store.js');
const { getFullContext } = await import('../src/context.js');
const session = await import('../src/broadcast/session.js');
const { linkPrompt } = await import('../src/llm/internal/prompts/scripts.js');

mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
  current: { temperature_2m: 20, weather_code: 0, is_day: 1 },
})));
after(() => {
  mock.restoreAll();
  rmSync(root, { recursive: true, force: true });
});

test('preview preference survives cold loads in both directions and defaults on for upgrades', async () => {
  await settings.load();
  assert.equal(settings.get().djBehaviour.previewNextShow, true);
  for (const value of [false, true]) {
    await settings.update({ djBehaviour: { previewNextShow: value } });
    setCache(null);
    await settings.load();
    assert.equal(settings.get().djBehaviour.previewNextShow, value);
  }
  const path = join(root, 'settings.json');
  const stored = JSON.parse(readFileSync(path, 'utf8'));
  for (const value of [undefined, 'false', null]) {
    if (value === undefined) delete stored.djBehaviour.previewNextShow;
    else stored.djBehaviour.previewNextShow = value;
    writeFileSync(path, JSON.stringify(stored));
    setCache(null);
    await settings.load();
    assert.equal(settings.get().djBehaviour.previewNextShow, true);
  }
  await settings.update({ djBehaviour: { previewNextShow: false } });
  await assert.rejects(settings.update({ djBehaviour: { previewNextShow: 'yes' } }),
    /previewNextShow must be a boolean/);
  assert.equal(settings.get().djBehaviour.previewNextShow, false);
});

test('preview toggles actual prompt facts while the presenter handoff stays eligible', async () => {
  const template = settings.get().personas[0];
  const outgoing = { ...template, id: 'p_outgoing', name: 'Outgoing' };
  const incoming = { ...template, id: 'p_incoming', name: 'Incoming' };
  const schedule: Record<number, string[]> = {};
  for (let day = 0; day < 7; day++) schedule[day] = Array(24).fill('s_outgoing');
  schedule[6][11] = 's_incoming';
  await settings.update({
    timezone: 'UTC', personas: [outgoing, incoming],
    shows: [
      { id: 's_outgoing', name: 'Outgoing show', personaId: outgoing.id },
      { id: 's_incoming', name: 'Incoming show', personaId: incoming.id },
    ], schedule,
  });
  const at = new Date('2026-09-05T10:50:00Z');
  await settings.update({ djBehaviour: { previewNextShow: true } });
  const withPreview = await getFullContext(at);
  assert.equal(withPreview.showHandover?.nextShow.name, 'Incoming show');
  assert.match(linkPrompt({ context: withPreview }), /Following show: Incoming presents/);

  await settings.update({ djBehaviour: { previewNextShow: false } });
  setCache(null);
  await settings.load();
  const withoutPreview = await getFullContext(at);
  assert.equal(withoutPreview.showHandover, null);
  assert.doesNotMatch(linkPrompt({ context: withoutPreview }), /Following show:/);
  session.start(withoutPreview);
  const incomingContext = await getFullContext(new Date('2026-09-05T11:00:00Z'));
  assert.equal(session.armBoundaryHandoff(incomingContext, { id: 'final-track' }), true);
  assert.equal(session.confirmBoundaryHandoffTrack({ id: 'final-track' }), true);
  assert.ok(session.pendingHandoff(), 'turning preview off does not suppress the presenter change');
});
