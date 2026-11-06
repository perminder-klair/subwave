import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const stateDir = mkdtempSync(join(tmpdir(), 'subwave-language-retry-'));
process.env.STATE_DIR = stateDir;

const db = await import('../src/music/library-db.js');
await db.open({ embeddingDim: 4 });

for (const id of ['unchecked', 'unknown', 'automatic', 'manual']) {
  db.upsertTrackMeta(id, { title: id, artist: 'Test Artist', album: 'Test Album' });
}

db.upsertTrackLanguage('unknown', {
  primaryLanguage: null,
  languages: [],
  mode: 'unknown',
  source: 'llm',
  confidence: 'review',
  contractVersion: 1,
});
db.upsertTrackLanguage('automatic', {
  primaryLanguage: 'eng',
  languages: ['eng'],
  mode: 'single',
  source: 'musicbrainz',
  confidence: 'high',
  contractVersion: 1,
});
db.upsertTrackLanguage('manual', {
  primaryLanguage: null,
  languages: [],
  mode: 'unknown',
  source: 'manual',
  confidence: 'review',
  contractVersion: 1,
});

test.after(() => {
  db.close();
  rmSync(stateDir, { recursive: true, force: true });
});

test('normal language runs retry unknown automatic results and preserve unavailable UI state', () => {
  assert.deepEqual(db.languagePendingIds(false), ['unchecked', 'unknown']);
  assert.equal(db.getTrack('unknown')?.language?.mode, 'unknown');
});

test('explicit re-language includes all automatic results but never manual results', () => {
  assert.deepEqual(db.languagePendingIds(true), ['automatic', 'unknown']);
});
