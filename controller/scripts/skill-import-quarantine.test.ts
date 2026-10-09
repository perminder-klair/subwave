// A skill's code runs only once the operator has read it and trusted it.
//
// The admin UI says an imported skill "arrives disabled for review", but the
// loader imported every tool.mjs on every scan and the catalog called each
// tool's ready() on every GET /dj/skills — so a bundle's module ran during the
// import request itself, enabled or not. Imported code now lands as
// tool.mjs.pending, which the loader never imports; POST …/tool/trust (with the
// digest of the source the operator was shown) is the one way it goes live.
//
// The probe module records every evaluation on globalThis, so "never ran" is
// observed, not inferred from a file name. Also pinned here:
//  - a tool.mjs already on disk (seeded, hand-placed or trusted earlier) keeps
//    loading exactly as before — the upgrade path;
//  - a SKILL.md with a mixed-case `name:` installs under the folder name the
//    loader will accept, rather than reporting success and never loading.
//
// requireAdmin is a no-op with ADMIN_USER/ADMIN_PASS unset, so the dj router
// mounts bare. Run: `npm test -- skill-import-quarantine`.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createTempDir } from './test-utils/temp-dir.js';

const STATE_DIR = createTempDir(join(tmpdir(), 'skill-import-quarantine-'));
process.env.STATE_DIR = STATE_DIR;
delete process.env.ADMIN_USER;
delete process.env.ADMIN_PASS;
const SKILLS = join(STATE_DIR, 'skills');

const probe = globalThis as unknown as { __skillProbe?: Record<string, number> };
probe.__skillProbe = {};
const runs = (slug: string) => probe.__skillProbe?.[slug] ?? 0;

// Top-level code AND ready() both count: either running before trust is the bug.
function toolSource(slug: string): string {
  return `globalThis.__skillProbe[${JSON.stringify(slug)}] = (globalThis.__skillProbe[${JSON.stringify(slug)}] || 0) + 1;
export const ready = () => {
  globalThis.__skillProbe[${JSON.stringify(slug)}] = (globalThis.__skillProbe[${JSON.stringify(slug)}] || 0) + 1;
  return true;
};
export default async function () { return { available: true, item: 'probe' }; }
`;
}

const AdmZip = (await import('adm-zip')).default;
function bundle(name: string, tool?: string): Blob {
  const zip = new AdmZip();
  zip.addFile('SKILL.md', Buffer.from(`---\nname: ${name}\nlabel: Probe\n---\nSay one line from the probe's item.\n`));
  if (tool) zip.addFile('tool.mjs', Buffer.from(tool));
  return new Blob([zip.toBuffer()], { type: 'application/zip' });
}

const express = (await import('express')).default;
const { router } = await import('../src/routes/dj.js');
const { discoverSeededKinds } = await import('../src/skills/loader.js');
await discoverSeededKinds();

const app = express();
app.use(express.json());
app.use(router);
const server = createServer(app);
await new Promise<void>(r => { server.listen(0, '127.0.0.1', () => r()); });
server.unref();
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function importZip(blob: Blob) {
  const fd = new FormData();
  fd.append('file', blob, 'skill.zip');
  const res = await fetch(`${base}/dj/skills/import`, { method: 'POST', body: fd });
  return { status: res.status, body: await res.json() as any };
}
async function catalogRow(slug: string) {
  const res = await fetch(`${base}/dj/skills`);
  const body = await res.json() as any;
  return body.skills.find((s: any) => s.name === slug);
}

test('an imported tool.mjs is quarantined and never evaluated', async () => {
  const { status, body } = await importZip(bundle('probe-a', toolSource('probe-a')));
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.slug, 'probe-a');
  assert.equal(body.toolPending, true);
  assert.equal(existsSync(join(SKILLS, 'probe-a', 'tool.mjs')), false, 'no live tool.mjs');
  assert.equal(existsSync(join(SKILLS, 'probe-a', 'tool.mjs.pending')), true);

  // The catalog read is where ready() used to run, on every poll.
  const row = await catalogRow('probe-a');
  assert.ok(row, 'the skill is listed');
  assert.equal(row.toolPending, true);
  assert.equal(row.hasTool, false);
  assert.equal(row.ready, false, 'a skill whose only tool awaits review cannot air');
  assert.equal(row.enabled, false);
  await fetch(`${base}/dj/skills/rescan`, { method: 'POST' });
  assert.equal(runs('probe-a'), 0, 'import, catalog and rescan must not run the module');
});

test('trusting needs the digest of the source that was read', async () => {
  const pending = await fetch(`${base}/dj/skills/probe-a/tool/pending`);
  assert.equal(pending.status, 200);
  const shown = await pending.json() as any;
  assert.equal(shown.source, toolSource('probe-a'));
  assert.match(shown.sha256, /^[0-9a-f]{64}$/);
  assert.equal(runs('probe-a'), 0, 'reading the source does not run it');

  const trust = (sha256?: string) => fetch(`${base}/dj/skills/probe-a/tool/trust`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sha256 === undefined ? {} : { sha256 }),
  });
  assert.equal((await trust()).status, 400);
  assert.equal((await trust('0'.repeat(64))).status, 409, 'a digest of other code is refused');
  assert.equal(runs('probe-a'), 0);

  const ok = await trust(shown.sha256);
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.equal(existsSync(join(SKILLS, 'probe-a', 'tool.mjs')), true);
  assert.equal(existsSync(join(SKILLS, 'probe-a', 'tool.mjs.pending')), false);
  assert.ok(runs('probe-a') > 0, 'trusted code is loaded');
  const row = await catalogRow('probe-a');
  assert.equal(row.hasTool, true);
  assert.equal(row.toolPending, false);
  assert.equal(row.ready, true);
});

test('discarding pending code removes it without ever loading it', async () => {
  const { status } = await importZip(bundle('probe-b', toolSource('probe-b')));
  assert.equal(status, 200);
  const res = await fetch(`${base}/dj/skills/probe-b/tool/pending`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.equal(existsSync(join(SKILLS, 'probe-b', 'tool.mjs.pending')), false);
  assert.equal(existsSync(join(SKILLS, 'probe-b', 'tool.mjs')), false);
  const row = await catalogRow('probe-b');
  assert.equal(row.toolPending, false);
  assert.equal(row.ready, true, 'with the code gone it is an ordinary prompt-only skill');
  assert.equal(runs('probe-b'), 0);
});

test('a tool.mjs already on disk keeps loading after the upgrade', async () => {
  const dir = join(SKILLS, 'probe-legacy');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: probe-legacy\n---\nSay one line.\n');
  writeFileSync(join(dir, 'tool.mjs'), toolSource('probe-legacy'));
  const res = await fetch(`${base}/dj/skills/rescan`, { method: 'POST' });
  assert.equal(res.status, 200);
  const row = await catalogRow('probe-legacy');
  assert.equal(row.hasTool, true);
  assert.equal(row.toolPending, false);
  assert.ok(runs('probe-legacy') > 0);
});

test('a mixed-case name installs under the slug the loader accepts', async () => {
  const { status, body } = await importZip(bundle('Mixed-Case-Skill'));
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.slug, 'mixed-case-skill');
  const written = readFileSync(join(SKILLS, 'mixed-case-skill', 'SKILL.md'), 'utf8');
  assert.match(written, /^name: mixed-case-skill$/m, 'the file says what the folder says');
  assert.ok(await catalogRow('mixed-case-skill'), 'and the loader actually loads it');

  const again = await importZip(bundle('Mixed-Case-Skill'));
  assert.equal(again.status, 409, 'a re-import is the ordinary duplicate refusal');
});

test('withSkillName rewrites only the name line, or refuses', async () => {
  const { withSkillName } = await import('../src/skills/install.js');
  const md = '---\nname: "Hello-There"\nlabel: Keep: me\n---\nThe brief.\n';
  const out = withSkillName(md, 'hello-there');
  assert.equal(out, '---\nname: hello-there\nlabel: Keep: me\n---\nThe brief.\n');
  // Already right: byte-identical.
  assert.equal(withSkillName('---\nname: ok\n---\nB\n', 'ok'), '---\nname: ok\n---\nB\n');
  // No frontmatter `name:` line to rewrite.
  assert.equal(withSkillName('No frontmatter at all', 'x'), null);
});
