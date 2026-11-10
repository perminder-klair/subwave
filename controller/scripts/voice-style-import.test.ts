import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

const root = mkdtempSync(join(tmpdir(), 'subwave-voice-style-import-'));
process.env.STATE_DIR = root;
delete process.env.ADMIN_USER;
delete process.env.ADMIN_PASS;
delete process.env.TTS_HEAVY_URL;
delete process.env.TTS_VOICE_DIR;
delete process.env.CHATTERBOX_VOICE_DIR;

const express = (await import('express')).default;
const AdmZip = (await import('adm-zip')).default;
const settings = await import('../src/settings.js');
const { personaSchema, PERSONA_VOICE_STYLE_MAX } = await import('../src/schemas/persona.js');
const { applyPersonaBundle } = await import('../src/personas/bundle.js');
const { router } = await import('../src/routes/backup.js');
const { BACKUP_FORMAT, BACKUP_VERSION } = await import('../src/backup/zip.js');
const { PERSONA_BUNDLE_FORMAT, PERSONA_BUNDLE_VERSION } = await import('../src/personas/bundle-pure.js');

const persona = personaSchema.parse({
  id: 'p_legacy', name: 'Legacy DJ', soul: 'A warm, dry broadcaster.', frequency: 'moderate',
  tts: { engine: 'gemini', voice: 'Puck', cloudProvider: 'openai' },
});
await settings.update({ personas: [persona] });
mkdirSync(join(root, 'voices'), { recursive: true });
const mediaPath = join(root, 'voices', 'existing.wav');
writeFileSync(mediaPath, 'current media');

const app = express();
app.use(express.json(), router);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

function snapshot() {
  return readdirSync(root, { recursive: true }).map(String).sort()
    .filter(file => statSync(join(root, file)).isFile())
    .map(file => [file, readFileSync(join(root, file)).toString('base64')]);
}

function backup(patch: unknown, extra: [string, string][] = []) {
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({ format: BACKUP_FORMAT, version: BACKUP_VERSION })));
  zip.addFile('settings.json', Buffer.from(JSON.stringify(patch)));
  zip.addFile('voices/existing.wav', Buffer.from('restored media'));
  for (const [file, data] of extra) zip.addFile(file, Buffer.from(data));
  return zip;
}

async function restore(zip: InstanceType<typeof AdmZip>, disk = false) {
  if (disk) {
    writeFileSync(join(root, 'legacy.zip'), zip.toBuffer());
    return fetch(`${base}/backup/import-file`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: 'legacy.zip' }),
    });
  }
  return fetch(`${base}/backup/import`, {
    method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: zip.toBuffer(),
  });
}

for (const length of [150, 151, 200, 300]) {
  test(`backup and bundle imports migrate a saved ${length}-character directive`, async () => {
    const voiceStyle = 'x'.repeat(length);
    const result = await restore(backup({ personas: [{ ...persona, voiceStyle }] }), length === 300);
    assert.equal(result.status, 200, await result.text());
    assert.equal(settings.get().personas[0].voiceStyle, voiceStyle.slice(0, PERSONA_VOICE_STYLE_MAX));
    assert.equal(readFileSync(mediaPath, 'utf8'), 'restored media');

    const zip = new AdmZip();
    zip.addFile('manifest.json', Buffer.from(JSON.stringify({ format: PERSONA_BUNDLE_FORMAT, version: PERSONA_BUNDLE_VERSION })));
    zip.addFile('persona.json', Buffer.from(JSON.stringify({ ...persona, name: `Imported ${length}`, voiceStyle })));
    const imported = await applyPersonaBundle(zip.toBuffer());
    assert.equal(imported.ok, true, JSON.stringify(imported));
    if (!imported.ok) return;
    assert.equal(imported.persona?.voiceStyle, voiceStyle.slice(0, PERSONA_VOICE_STYLE_MAX));
  });
}

test('new edits still reject directives above the current cap', async () => {
  const before = snapshot();
  await assert.rejects(settings.update({ personas: [{ ...persona, voiceStyle: 'x'.repeat(151) }] }), /voiceStyle/);
  assert.deepEqual(snapshot(), before);
});

for (const invalid of [
  { voiceStyle: 'x'.repeat(301) }, { voiceStyle: 42 },
  { soul: '' }, { frequency: 'unrecognised' }, { language: 42 },
]) {
  test(`legacy migration does not repair unrelated persona errors: ${Object.keys(invalid)[0]}`, async () => {
    const incoming = { ...persona, voiceStyle: 'x'.repeat(200), ...invalid };
    writeFileSync(mediaPath, 'current media');
    const before = snapshot();
    const result = await restore(backup({ personas: [incoming] }));
    assert.deepEqual(snapshot(), before, 'refused backup must not overwrite media or settings');
    assert.equal(result.status, 400, await result.text());

    const zip = new AdmZip();
    zip.addFile('manifest.json', Buffer.from(JSON.stringify({ format: PERSONA_BUNDLE_FORMAT, version: PERSONA_BUNDLE_VERSION })));
    zip.addFile('persona.json', Buffer.from(JSON.stringify({ ...incoming, name: 'Invalid imported DJ' })));
    zip.addFile('jingles/rejected.wav', Buffer.from('must not be adopted'));
    const imported = await applyPersonaBundle(zip.toBuffer());
    assert.equal(imported.ok, false);
    assert.equal(imported.status, 400);
    assert.deepEqual(snapshot(), before, 'refused bundle must not adopt its audio');
  });
}

test('other invalid backup settings are rejected before overwriting media', async () => {
  writeFileSync(mediaPath, 'current media');
  const before = snapshot();
  const result = await restore(backup({ personas: [{ ...persona, voiceStyle: 'x'.repeat(200) }], crossfadeDuration: -1 }));
  assert.deepEqual(snapshot(), before);
  assert.equal(result.status, 400, await result.text());
});

test('corrupt settings JSON is rejected before overwriting media', async () => {
  const zip = backup({});
  zip.updateFile('settings.json', Buffer.from('{'));
  writeFileSync(mediaPath, 'current media');
  const before = snapshot();
  const result = await restore(zip);
  assert.deepEqual(snapshot(), before);
  assert.equal(result.status, 400);
});

test('backup validation sees custom themes in the archive before they are written', async () => {
  const theme = { id: 'restored-palette', name: 'Restored palette', mode: 'dark', tokens: { '--accent': '#abcdef' } };
  const result = await restore(backup({
    personas: [{ ...persona, voiceStyle: 'x'.repeat(300) }], theme: { active: theme.id },
    shows: [{ id: 's_restored', name: 'Restored show', personaId: persona.id, themeId: theme.id }],
  }, [['themes/restored-palette.json', JSON.stringify(theme)]]));
  assert.equal(result.status, 200, await result.text());
  assert.equal(settings.get().theme.active, theme.id);
  assert.equal(settings.get().shows[0].themeId, theme.id);
});
