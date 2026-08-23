import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const audit = path.resolve(import.meta.dirname, 'audit-admin-query.mjs');

test('reports a direct adminFetch call split before its opening parenthesis', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'subwave-admin-audit-'));
  const fixture = path.join(fixtureRoot, 'Multiline.tsx');
  fs.writeFileSync(fixture, "const response = adminFetch\n('/fixture');\n");

  try {
    const result = spawnSync(process.execPath, [audit, '--root', fixtureRoot], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Multiline\.tsx:1: unclassified adminFetch call/);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
