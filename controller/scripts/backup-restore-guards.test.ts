// A backup restore applies the same guards the dedicated import paths do.
//
// Restore used to extract jingles.m3u, jingles.json, sfx.json and skills/**
// verbatim. Each of those has a dedicated import path with rules the restore
// skipped, and each rule exists because the file is read by something that
// trusts it:
//
//  - jingles.m3u is a list of requests Liquidsoap reloads on watch. It is no
//    longer read from the archive at all; it is regenerated from the restored
//    jingles.json, whose keys answer to the same isAdoptableName a persona
//    bundle's jingle does.
//  - sfx.json `file` values are joined onto the sfx folder by getPath/remove,
//    so a row must be `<slug>.<audio ext>` — the only shape the writers make.
//  - skills/** goes through the skill import's guards, so a tool.mjs that is
//    not already live (or shipped in this image) arrives as tool.mjs.pending.
//
// requireAdmin is a no-op with ADMIN_USER/ADMIN_PASS unset, so the router
// mounts bare. Run: `npm test -- backup-restore-guards`.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import { createTempDir } from './test-utils/temp-dir.js';

const stateRoot = path.join(createTempDir(path.join(tmpdir(), 'subwave-restore-guards-')), 'state');
mkdirSync(stateRoot);
process.env.STATE_DIR = stateRoot;
delete process.env.ADMIN_USER;
delete process.env.ADMIN_PASS;
const SKILLS = path.join(stateRoot, 'skills');

// A custom skill that already has trusted code on this station.
mkdirSync(path.join(SKILLS, 'kept-tool'), { recursive: true });
writeFileSync(path.join(SKILLS, 'kept-tool', 'SKILL.md'), '---\nname: kept-tool\n---\nOld brief.\n');
writeFileSync(path.join(SKILLS, 'kept-tool', 'tool.mjs'), 'export default async () => ({ v: "live" });\n');

const AdmZip = (await import('adm-zip')).default;
const express = (await import('express')).default;
const { router } = await import('../src/routes/backup.js');
const { BACKUP_FORMAT, BACKUP_VERSION } = await import('../src/backup/zip.js');
const { readTemplate, discoverSeededKinds } = await import('../src/skills/loader.js');
await discoverSeededKinds();

const app = express();
app.use(router);
const server = createServer(app);
await new Promise<void>(r => { server.listen(0, '127.0.0.1', () => r()); });
server.unref();
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

function backupOf(members: [string, string | Buffer][]): Buffer {
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({ format: BACKUP_FORMAT, version: BACKUP_VERSION })));
  for (const [name, data] of members) zip.addFile(name, Buffer.isBuffer(data) ? data : Buffer.from(data));
  return zip.toBuffer();
}
async function restore(body: Buffer) {
  const res = await fetch(`${base}/backup/import`, { method: 'POST', body: new Uint8Array(body) });
  return { status: res.status, body: await res.json() as any };
}

const weatherTpl = await readTemplate('weather');
assert.ok(weatherTpl?.toolPath, 'the weather built-in ships a tool.mjs');
const WEATHER_TOOL = readFileSync(weatherTpl.toolPath);

const outcome = await restore(backupOf([
  ['jingles.json', JSON.stringify({
    items: {
      'jingle_good.wav': { text: 'Good ident', createdAt: '2026-01-01T00:00:00Z' },
      'evil.wav\n/etc/passwd\nx.wav': { text: 'smuggled lines' },
      '../outside.wav': { text: 'traversal' },
    },
  })],
  ['jingles.m3u', '/somewhere/else/entirely.wav\n'],
  ['jingles/jingle_good.wav', 'ident bytes'],
  ['sfx.json', JSON.stringify({
    items: {
      airhorn: { name: 'airhorn', file: 'airhorn.mp3', durationSec: 1.5, builtin: true },
      escape: { name: 'escape', file: '../settings.json' },
      'Not A Slug': { file: 'x.mp3' },
    },
  })],
  ['skills/arrived/SKILL.md', '---\nname: arrived\n---\nSay one line.\n'],
  ['skills/arrived/tool.mjs', 'globalThis.__restoredRan = true;\nexport default async () => ({});\n'],
  ['skills/arrived/helper.mjs', 'export const x = 1;\n'],
  ['skills/kept-tool/SKILL.md', '---\nname: kept-tool\n---\nNew brief.\n'],
  ['skills/kept-tool/tool.mjs', 'export default async () => ({ v: "from the backup" });\n'],
  ['skills/weather/SKILL.md', '---\nname: weather\n---\nWeather brief.\n'],
  ['skills/weather/tool.mjs', WEATHER_TOOL],
  ['skills/Mixed/SKILL.md', '---\nname: Mixed\n---\nBrief.\n'],
  ['skills/link/SKILL.md', '---\nname: link\n---\nShadows a queue kind.\n'],
]));

test('the restore succeeds and reports what it left out', () => {
  assert.equal(outcome.status, 200, JSON.stringify(outcome.body));
  const skipped: string[] = outcome.body.skipped;
  assert.ok(skipped.some(s => s.startsWith('skills/arrived/helper.mjs')));
  assert.ok(skipped.some(s => s.startsWith('skills/Mixed/SKILL.md')));
  assert.ok(skipped.some(s => s.startsWith('skills/link')));
  assert.ok(skipped.some(s => s.includes('../settings.json') || s.includes('"escape"')));
});

test('jingles.m3u is regenerated from validated sidecar keys, never copied', () => {
  const m3u = readFileSync(path.join(stateRoot, 'jingles.m3u'), 'utf8');
  assert.equal(m3u, `${stateRoot}/jingles/jingle_good.wav\n`);
  const sidecar = JSON.parse(readFileSync(path.join(stateRoot, 'jingles.json'), 'utf8'));
  assert.deepEqual(Object.keys(sidecar.items), ['jingle_good.wav']);
  assert.equal(existsSync(path.join(stateRoot, 'jingles', 'jingle_good.wav')), true, 'audio still restores');
});

test('sfx.json keeps only rows the writers could have made', () => {
  const sidecar = JSON.parse(readFileSync(path.join(stateRoot, 'sfx.json'), 'utf8'));
  assert.deepEqual(Object.keys(sidecar.items), ['airhorn']);
  assert.equal(sidecar.items.airhorn.file, 'airhorn.mp3');
});

test('restored code is quarantined unless it is already live or shipped', () => {
  assert.deepEqual([...outcome.body.skillsAwaitingReview].sort(), ['arrived', 'kept-tool']);

  assert.equal(existsSync(path.join(SKILLS, 'arrived', 'tool.mjs')), false);
  assert.equal(existsSync(path.join(SKILLS, 'arrived', 'tool.mjs.pending')), true);
  assert.equal(existsSync(path.join(SKILLS, 'arrived', 'helper.mjs')), false);
  assert.equal((globalThis as any).__restoredRan, undefined);

  // The station's trusted code keeps running; the backup's waits beside it.
  assert.match(readFileSync(path.join(SKILLS, 'kept-tool', 'tool.mjs'), 'utf8'), /"live"/);
  assert.match(readFileSync(path.join(SKILLS, 'kept-tool', 'tool.mjs.pending'), 'utf8'), /from the backup/);
  assert.match(readFileSync(path.join(SKILLS, 'kept-tool', 'SKILL.md'), 'utf8'), /New brief/);

  // A built-in's shipped tool is the code the seeder writes anyway.
  assert.deepEqual(readFileSync(path.join(SKILLS, 'weather', 'tool.mjs')), WEATHER_TOOL);
  assert.equal(existsSync(path.join(SKILLS, 'weather', 'tool.mjs.pending')), false);

  assert.equal(existsSync(path.join(SKILLS, 'Mixed')), false);
  assert.equal(existsSync(path.join(SKILLS, 'link')), false);
});

test('a corrupt sidecar refuses the restore before anything is written', async () => {
  const before = readFileSync(path.join(stateRoot, 'jingles.json'), 'utf8');
  const bad = await restore(backupOf([
    ['sfx.json', '{ not json'],
    ['jingles.json', JSON.stringify({ items: {} })],
  ]));
  assert.equal(bad.status, 400);
  assert.equal(readFileSync(path.join(stateRoot, 'jingles.json'), 'utf8'), before);
});

test('an oversized JSON member is refused by its declared size', async () => {
  const big = Buffer.alloc(17 * 1024 * 1024, 0x20);
  const res = await restore(backupOf([['jingles.json', Buffer.concat([Buffer.from('{"items":{}}'), big])]]));
  assert.equal(res.status, 400);
  assert.match(res.body.error, /too large/);
});

test('ZIP path aliases cannot overwrite routed sidecars or the jingle playlist', async () => {
  const files = ['jingles.m3u', 'jingles.json', 'sfx.json'];
  const before = new Map(files.map(file => [file, readFileSync(path.join(stateRoot, file))]));
  for (const file of files) {
    for (const suffix of ['/.', '//.', '\\.']) {
      const alias = file + suffix;
      const zip = new AdmZip(backupOf([]));
      zip.addFile('alias', Buffer.from(file === 'jingles.m3u'
        ? '/not-this-station.wav\n'
        : '{"items":{"escape":{"file":"../settings.json"}}}'));
      const entry = zip.getEntry('alias');
      assert.ok(entry);
      // addFile normalizes paths; the serialized member must retain the alias.
      entry.entryName = alias;
      zip.addFile('sfx/restored.mp3', Buffer.from('restored audio'));
      const result = await restore(zip.toBuffer());
      assert.equal(result.status, 200, alias);
      assert.deepEqual(result.body.restored, ['sfx'], alias);
      for (const target of files) {
        assert.deepEqual(readFileSync(path.join(stateRoot, target)), before.get(target), alias);
      }
      assert.equal(readFileSync(path.join(stateRoot, 'sfx', 'restored.mp3'), 'utf8'), 'restored audio');
    }
  }
});
