// /llms.txt follows the llmstxt.org shape, and every link in it still points at
// something real: a page under web/app (declaring the same scope it is linked
// with), or a Markdown file in the repo. A renamed manual page or a moved doc
// fails here rather than as a dead link handed to a model.
//
// Run: `npm test -- llms-txt`.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { buildLlmsTxt, LLMS_SECTIONS, REPO_RAW_URL } from './llms-txt';

const webRoot = process.cwd();
const repoRoot = path.join(webRoot, '..');

const urls = {
  page: (p: string, scope: string) => `https://${scope}.test${p}`,
  endpoint: (p: string) => `https://station.test${p}`,
};

const links = LLMS_SECTIONS.flatMap((s) => s.links);

test('the file has the llmstxt.org shape: H1, summary, H2 link lists, Optional last', () => {
  const lines = buildLlmsTxt(urls).split('\n');
  assert.equal(lines[0], '# SUB/WAVE');
  assert.match(lines[2] ?? '', /^> \S/);

  const headings = lines.filter((l) => l.startsWith('#'));
  assert.equal(headings.filter((l) => l.startsWith('# ')).length, 1);
  assert.ok(headings.slice(1).every((l) => l.startsWith('## ')), 'only H2s after the title');
  assert.equal(headings.at(-1), '## Optional');

  const firstSection = lines.findIndex((l) => l.startsWith('## '));
  for (const line of lines.slice(firstSection)) {
    if (line === '' || line.startsWith('## ')) continue;
    assert.match(line, /^- \[[^\]]+\]\(https?:\/\/[^)\s]+\)(: \S.*)?$/, line);
  }
});

test('each link resolves through its own kind', () => {
  const out = buildLlmsTxt(urls);
  assert.ok(out.includes('(https://shared.test/manual/dj)'));
  assert.ok(out.includes('(https://station.test/listen)'));
  assert.ok(out.includes('(https://station.test/stream.mp3)'));
  assert.ok(out.includes(`(${REPO_RAW_URL}/docs/api.md)`));
});

test('every linked page exists and is linked with the scope it declares', () => {
  for (const { href } of links) {
    if (!('page' in href)) continue;
    const file = path.join(webRoot, 'app', href.page, 'page.tsx');
    assert.ok(existsSync(file), `${href.page} has no page.tsx`);
    const declaresStation = /scope: 'station'/.test(readFileSync(file, 'utf8'));
    assert.equal(href.scope === 'station', declaresStation, `${href.page} scope`);
  }
});

test('every linked repo file exists', () => {
  for (const { href } of links) {
    if (!('repo' in href)) continue;
    assert.ok(existsSync(path.join(repoRoot, href.repo)), `${href.repo} is missing`);
  }
});

test('no link appears twice', () => {
  const out = buildLlmsTxt(urls);
  const targets = [...out.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]);
  assert.deepEqual(targets.filter((t, i) => targets.indexOf(t) !== i), []);
});
